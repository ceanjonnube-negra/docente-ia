// scripts/verificar-generacion-imagenes.ts
//
// Prueba aislada de "Implementar en Docente IA la capacidad de generar
// imágenes y documentos ilustrados" — Fase 0+1 (ImageGenerationService
// desacoplado + generación de imagen suelta end-to-end desde el Chat
// IA + persistencia + vista previa + guardar/descargar/compartir/
// regenerar).
//
// Mismo límite honesto que el resto de esta serie: una llamada REAL al
// proveedor de imágenes y una sesión REAL de Supabase no se pueden
// fabricar en un script aislado, así que esta prueba combina (a)
// ejecución REAL de lo que sí es puro (construirPromptFinal,
// tamanoParaFormato) y (b) verificación ESTRUCTURAL de los invariantes
// en el código real (activación de la rama 'imagen', precedencia de
// materialVisualActivo, versionado, RLS de la tabla nueva, "la tarjeta
// nunca dispara mensajes de chat").
// Se ejecuta con `npx tsx scripts/verificar-generacion-imagenes.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// NUNCA se importa herramientas.ts/ImageGenerationService.ts/
// AsistenteService.ts aquí — todos transitivamente tocan un cliente
// real (Supabase u OpenAI) o el navegador. reglasVisuales.ts y
// lib/asistente/documentos.ts SÍ son seguros: puros, sin imports, sin
// red, sin `process.env` en el módulo.
import { construirPromptFinal, tamanoParaFormato } from '../lib/imageGen/reglasVisuales'
import { pareceEdicionDeImagenActiva, detectarHerramientaDocumento } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function sinComentarios(codigo: string): string {
  return codigo
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//'))
    .join('\n')
}

const RAIZ = join(__dirname, '..')
const cuerpoHerramientas = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf-8')
const cuerpoAlmacenamiento = readFileSync(join(RAIZ, 'lib/documentGen/almacenamiento.ts'), 'utf-8')
const cuerpoAssetsVisuales = readFileSync(join(RAIZ, 'lib/assetsVisuales.ts'), 'utf-8')
const cuerpoImageService = readFileSync(join(RAIZ, 'lib/imageGen/ImageGenerationService.ts'), 'utf-8')
const cuerpoProveedorOpenAI = readFileSync(join(RAIZ, 'lib/imageGen/proveedores/openaiImagenes.ts'), 'utf-8')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoAsistenteService = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')
const cuerpoPersistencia = readFileSync(join(RAIZ, 'lib/asistente/persistencia.ts'), 'utf-8')
const cuerpoPanel = readFileSync(join(RAIZ, 'components/Asistente/AsistentePanel.tsx'), 'utf-8')
const cuerpoMigracion = readFileSync(join(RAIZ, 'supabase/migrations/20260808210000_crear_assets_visuales.sql'), 'utf-8')

async function main() {
  // ============================================================
  // 1. ImageGenerationService — desacoplado del proveedor, reglas
  //    pedagógicas SIEMPRE aplicadas (ejecución REAL, función pura).
  // ============================================================
  {
    const prompt1 = construirPromptFinal({ prompt: 'Un jardín con flores' })
    verificar(prompt1.includes('Un jardín con flores'), 'construirPromptFinal conserva el prompt real del maestro')
    verificar(/educaci[oó]n b[aá]sica/i.test(prompt1), 'construirPromptFinal SIEMPRE agrega el contexto pedagógico fijo (nunca opcional)')
    verificar(/sin violencia/i.test(prompt1), 'construirPromptFinal SIEMPRE agrega la regla de seguridad fija (nunca opcional, ni con estilo/tema personalizados)')
    const prompt2 = construirPromptFinal({ prompt: 'x', estilo: 'infantil', restriccionImpresion: 'blanco-y-negro' })
    verificar(/infantil/i.test(prompt2), 'construirPromptFinal aplica el estilo pedido')
    verificar(/blanco y negro|escala de grises/i.test(prompt2), 'construirPromptFinal aplica la restricción de impresión pedida')
    verificar(tamanoParaFormato('horizontal') === '1536x1024' && tamanoParaFormato('vertical') === '1024x1536' && tamanoParaFormato(undefined) === '1024x1024', 'tamanoParaFormato mapea correctamente cuadrado/horizontal/vertical (cuadrado = default)')
  }
  verificar(cuerpoImageService.includes('interface ProveedorImagenes') && cuerpoImageService.includes('generarImagenOpenAI'), 'ImageGenerationService define la abstracción ProveedorImagenes y usa una implementación real intercambiable (OpenAI)')
  verificar(!/import OpenAI|import.*supabase-js/i.test(cuerpoImageService), 'ImageGenerationService.ts no importa ningún SDK de proveedor directamente — solo la abstracción')

  // ============================================================
  // 2. Cliente OpenAI construido de forma perezosa (nunca al cargar
  //    el módulo) — mismo criterio que motorOpenAIRealtime.ts, para
  //    no romper scripts que lo importen transitivamente sin
  //    OPENAI_API_KEY en el entorno.
  // ============================================================
  verificar(!/^const client = new OpenAI/m.test(cuerpoProveedorOpenAI), 'openaiImagenes.ts NO construye el cliente OpenAI al cargar el módulo')
  verificar(cuerpoProveedorOpenAI.includes('function obtenerCliente()'), 'openaiImagenes.ts construye el cliente de forma perezosa, dentro de una función')
  verificar(cuerpoProveedorOpenAI.includes("model: 'gpt-image-1'"), 'openaiImagenes.ts usa gpt-image-1 (siempre devuelve base64 — sin url ni segundo fetch)')

  // ============================================================
  // 3. herramientas.ts — 'imagen' ya está activada de verdad (no
  //    HerramientaNoDisponibleError); audio/video siguen sin decidir.
  // ============================================================
  verificar(!/if \(tipo === 'imagen' \|\| tipo === 'audio' \|\| tipo === 'video'\)/.test(cuerpoHerramientas), "herramientas.ts ya NO agrupa 'imagen' junto con audio/video en el rechazo genérico")
  verificar(/if \(tipo === 'audio' \|\| tipo === 'video'\)/.test(cuerpoHerramientas), 'herramientas.ts sigue rechazando audio/video explícitamente con HerramientaNoDisponibleError (fuera de alcance de esta fase)')
  verificar(cuerpoHerramientas.includes("if (tipo === 'imagen') {") && cuerpoHerramientas.includes('ejecutarGeneracionImagen('), "herramientas.ts enruta tipo==='imagen' a un pipeline real propio (ejecutarGeneracionImagen)")
  verificar(cuerpoHerramientas.includes('generarImagen({ prompt })'), 'ejecutarGeneracionImagen llama al servicio desacoplado real, nunca a un SDK de proveedor directo')
  verificar(cuerpoHerramientas.includes("firma[0] !== 0x89 || firma[1] !== 0x50 || firma[2] !== 0x4e || firma[3] !== 0x47"), 'ejecutarGeneracionImagen verifica la firma binaria PNG real antes de subir (mismo criterio que word/pdf/pptx/xlsx, nunca se confía ciegamente en el buffer del proveedor)')
  verificar(cuerpoHerramientas.includes('BUCKET_IMAGENES_GENERADAS'), 'Las imágenes se suben a su propio bucket (nunca mezclado con documentos-generados-ia)')
  {
    const sinComentariosHerramientas = sinComentarios(cuerpoHerramientas)
    verificar(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(sinComentariosHerramientas.split('ejecutarGeneracionImagen')[1] || ''), 'ejecutarGeneracionImagen nunca referencia service_role directamente (usa el parámetro sb ya resuelto por route.ts, igual que el resto del archivo)')
    verificar(cuerpoHerramientas.includes('guardarAssetVisual(supabaseUser,'), 'La persistencia en BD usa el cliente AUTENTICADO del docente (supabaseUser), nunca service_role — mismo criterio que turnos_chat')
  }
  verificar(cuerpoHerramientas.includes('No se pudo guardar el registro del asset visual (no bloquea la entrega)'), 'Un fallo guardando el registro en BD nunca bloquea la entrega de la imagen ya generada y verificada (mejor esfuerzo real, no un requisito duro)')

  // ============================================================
  // 3b. EDICIÓN real con la imagen anterior como entrada (ver
  //     "corrección — edición real de imágenes con el asset visual
  //     anterior como entrada"): con versionAnteriorId, el pipeline
  //     DESCARGA el archivo real y lo edita — nunca regenera desde
  //     cero con solo texto.
  // ============================================================
  {
    const inicioFn = cuerpoHerramientas.indexOf('async function ejecutarGeneracionImagen(')
    const finFn = cuerpoHerramientas.indexOf('\nfunction medirEtapaSync', inicioFn)
    const cuerpoFn = cuerpoHerramientas.slice(inicioFn, finFn)
    verificar(cuerpoFn.includes('if (versionAnteriorId) {'), 'ejecutarGeneracionImagen distingue explícitamente el caso de edición (versionAnteriorId presente) del de generación nueva')
    verificar(cuerpoFn.includes('obtenerAssetVisualPorId(supabaseUser, versionAnteriorId)'), 'La edición busca la fila real del asset anterior (para obtener su storagePath) — nunca reconstruye el archivo solo a partir de metadata')
    verificar(cuerpoFn.includes('descargarBuffer(sb, assetAnterior.storagePath, BUCKET_IMAGENES_GENERADAS)'), 'La edición DESCARGA el buffer real de la imagen anterior desde Storage')
    verificar(cuerpoFn.includes('editarImagen(bufferOriginal, prompt)'), 'La edición llama a editarImagen() con el buffer REAL descargado — nunca a generarImagen() (texto→imagen desde cero) cuando hay versionAnteriorId')
    const iRamaEdicion = cuerpoFn.indexOf('if (versionAnteriorId) {')
    const iElse = cuerpoFn.indexOf('} else {', iRamaEdicion)
    const ramaEdicionSola = cuerpoFn.slice(iRamaEdicion, iElse)
    verificar(iRamaEdicion !== -1 && iElse !== -1 && !ramaEdicionSola.includes('generarImagen({ prompt })'), 'La rama de edición (antes del else) nunca cae en generarImagen() (generación desde cero) — están completamente separadas')
  }
  verificar(cuerpoHerramientas.includes('descargarBuffer') && cuerpoHerramientas.includes('obtenerAssetVisualPorId'), 'herramientas.ts importa las funciones reales de descarga/consulta necesarias para editar')

  // ============================================================
  // 4. almacenamiento.ts — bucket nuevo, tipo extendido, assetId
  //    aditivo (nunca rompe ArchivoGenerado/ArchivoGeneradoInfo
  //    existentes, ambos opcionales).
  // ============================================================
  verificar(cuerpoAlmacenamiento.includes("BUCKET_IMAGENES_GENERADAS = 'imagenes-generadas-ia'"), 'Bucket propio para imágenes, mismo patrón que BUCKET_HOJAS_SEGUIMIENTO')
  verificar(cuerpoAlmacenamiento.includes("TipoArchivoGenerado = 'word' | 'pdf' | 'powerpoint' | 'excel' | 'imagen'"), "TipoArchivoGenerado extendido de forma aditiva con 'imagen'")
  verificar(cuerpoAlmacenamiento.includes('assetId?: string'), 'assetId es opcional en ArchivoGenerado — nunca rompe los generadores existentes que no lo usan')
  verificar(cuerpoAlmacenamiento.includes('export async function descargarBuffer('), 'Existe descargarBuffer() — necesaria para poder editar una imagen ya generada')
  verificar(cuerpoAssetsVisuales.includes('export async function obtenerAssetVisualPorId('), 'Existe obtenerAssetVisualPorId() — necesaria para recuperar el storagePath real del asset anterior antes de editarlo')

  // ============================================================
  // 4b. ImageGenerationService/openaiImagenes — editar() es una
  //     operación real imagen→imagen (images.edit), NUNCA
  //     images.generate reetiquetado.
  // ============================================================
  verificar(cuerpoImageService.includes('editar(bufferOriginal: Buffer, promptFinal: string)') && cuerpoImageService.includes('export async function editarImagen('), 'ProveedorImagenes.editar() recibe el buffer REAL de la imagen anterior — la abstracción ya contempla edición, no solo generación')
  verificar(cuerpoProveedorOpenAI.includes('.images.edit({') && cuerpoProveedorOpenAI.includes("image: archivoOriginal"), 'editarImagenOpenAI llama a client.images.edit() con la imagen real como parámetro `image` — nunca client.images.generate()')
  verificar(cuerpoProveedorOpenAI.includes("input_fidelity: 'high'"), 'editarImagenOpenAI pide input_fidelity alto — el proveedor debe esforzarse en conservar el estilo/composición de la imagen de entrada')
  verificar(cuerpoProveedorOpenAI.includes("import OpenAI, { toFile } from 'openai'") && cuerpoProveedorOpenAI.includes('await toFile(bufferOriginal,'), 'El buffer se convierte a un archivo real (toFile) antes de mandarlo — mismo SDK oficial, sin reimplementar multipart a mano')

  // ============================================================
  // 5. Migración assets_visuales — 100% aditiva, RLS "solo titular",
  //    sin service_role, sin DELETE, versionado real (version +
  //    version_anterior_id + vigente, nunca DROP/borrado real).
  // ============================================================
  verificar(cuerpoMigracion.includes('create table if not exists public.assets_visuales'), 'Esquema: create table if not exists (idempotente)')
  verificar(cuerpoMigracion.includes('alter table public.assets_visuales enable row level security'), 'RLS activado sobre assets_visuales')
  verificar(cuerpoMigracion.includes('using (docente_id = auth.uid())'), 'RLS "solo titular" — mismo patrón que turnos_chat/planeaciones')
  verificar(cuerpoMigracion.includes("version integer not null default 1") && cuerpoMigracion.includes('version_anterior_id uuid references public.assets_visuales(id)') && cuerpoMigracion.includes('vigente boolean not null default true'), 'Versionado real: version + version_anterior_id + vigente — "regenerar" nunca borra')
  {
    const migracionSinComentarios = sinComentarios(cuerpoMigracion)
    verificar(!/for all/i.test(migracionSinComentarios), 'RLS: sin políticas FOR ALL')
    verificar(!/for delete/i.test(migracionSinComentarios), 'RLS: sin política DELETE — nada en este flujo borra un asset visual')
    verificar(!/service_role/i.test(migracionSinComentarios), 'Migración: no usa service_role')
    verificar(!/\bdrop table\b|\bdrop column\b|\balter table\s+public\.(?!assets_visuales)/i.test(migracionSinComentarios), 'Migración: no modifica ninguna tabla/columna existente (100% aditiva)')
  }

  // ============================================================
  // 6. lib/assetsVisuales.ts — versionado real: la fila nueva calcula
  //    version = anterior.version + 1 y marca la anterior vigente=false
  //    (nunca DELETE).
  // ============================================================
  verificar(cuerpoAssetsVisuales.includes("version = (anterior?.version ?? 0) + 1"), 'guardarAssetVisual calcula version = anterior.version + 1 cuando hay versionAnteriorId')
  verificar(cuerpoAssetsVisuales.includes(".update({ vigente: false })"), 'guardarAssetVisual marca la versión anterior vigente=false en vez de borrarla')
  verificar(!/\.delete\(\)/.test(cuerpoAssetsVisuales), 'lib/assetsVisuales.ts nunca ejecuta DELETE sobre assets_visuales')

  // ============================================================
  // 7. app/api/chat/route.ts — REGENERAR IMAGEN es un camino rápido
  //    real (nunca pasa por Claude), CASO 3 soporta imagen suelta sin
  //    exigir MODO DOCUMENTO, MODO IMAGEN existe en el prompt de
  //    sistema, CAPACIDADES ya no dice que no puede generar imágenes.
  // ============================================================
  verificar(cuerpoChatRoute.includes('regenerarImagen') && cuerpoChatRoute.includes("'regenerar-imagen'"), 'Existe el camino rápido de regeneración de imagen')
  verificar(/if \(supabaseUser && userId && regenerarImagen[\s\S]{0,800}ejecutarHerramientaDocumento\('imagen', mensaje,/.test(cuerpoChatRoute), 'REGENERAR IMAGEN llama directo a ejecutarHerramientaDocumento — nunca pasa por client.messages.create (Claude)')
  verificar(cuerpoChatRoute.includes('const esImagenSuelta = ') && cuerpoChatRoute.includes("tipoHerramientaSolicitado === 'imagen'"), 'CASO 3 distingue imagen suelta de documento formal (esDocumentoFormal no aplica a imágenes)')
  verificar(cuerpoChatRoute.includes('MODO IMAGEN ACTIVO'), 'El prompt de sistema incluye instrucciones específicas para MODO IMAGEN')
  verificar(cuerpoChatRoute.includes('${bloqueModoImagen}'), 'bloqueModoImagen se concatena al prompt de sistema (mismo patrón que bloqueVoz/bloqueConsultaOficial — condicional, nunca cambia el prompt general)')
  verificar(cuerpoChatRoute.includes('También SÍ genera imágenes reales'), 'CAPACIDADES ya declara que la app SÍ genera imágenes reales — Claude nunca debe decir "no puedo generar imágenes"')

  // ============================================================
  // 8. AsistenteService.ts — materialVisualActivo es un concepto
  //    PARALELO a documentoActivo (documentoActivo sigue teniendo
  //    prioridad absoluta, ver enviarMensaje), nunca interfiere con
  //    la edición de documentos de texto existente.
  // ============================================================
  {
    const inicioEnviarMensaje = cuerpoAsistenteService.indexOf('async enviarMensaje(texto: string')
    const inicioDocActivo = cuerpoAsistenteService.indexOf('if (this.documentoActivo) {', inicioEnviarMensaje)
    const inicioMaterialVisual = cuerpoAsistenteService.indexOf('if (this.materialVisualActivo', inicioEnviarMensaje)
    verificar(inicioDocActivo !== -1 && inicioMaterialVisual !== -1 && inicioDocActivo < inicioMaterialVisual, 'enviarMensaje() evalúa documentoActivo ANTES que materialVisualActivo — un documento de texto activo sigue ganando siempre, sin cambios de comportamiento para el caso ya existente')
  }
  verificar(cuerpoAsistenteService.includes('private materialVisualActivo: MaterialVisualActivoGuardado | null = null'), 'Existe el campo materialVisualActivo, separado de documentoActivo')
  verificar(cuerpoAsistenteService.includes('await this.enviarRegeneracionImagen(limpio)'), 'Un mensaje de texto simple con materialVisualActivo activo (sin documentoActivo) puede enrutarse a edición')
  verificar(!cuerpoAsistenteService.includes('construirPromptRegeneracionImagen'), 'Ya NO existe construirPromptRegeneracionImagen (texto) — la composición ahora la preserva la imagen real, no un prompt recompuesto (ver corrección de edición real)')
  verificar(/await \(await this\.motorDeContenido\(\)\)\?\.\s*enviarTexto\(instruccion,/.test(cuerpoAsistenteService), 'enviarRegeneracionImagen manda la instrucción del docente TAL CUAL (sin combinarla con texto previo)')
  verificar(cuerpoAsistenteService.includes("evento.archivo?.tipo === 'imagen'") , 'La respuesta de una imagen suelta (CASO 3) NUNCA se trata como documentoActivo — tiene su propia rama')

  // ============================================================
  // 8b. Clasificación IMAGE_CREATE / IMAGE_EDIT / conversación normal
  //     (ver "corrección — distinguir IMAGE_CREATE de IMAGE_EDIT" y
  //     "el docente pregunta algo sin relación con materialVisualActivo
  //     activo no debe editar la imagen").
  // ============================================================
  {
    const lineaGate = "if (this.materialVisualActivo && !adjunto && canal !== 'voz' && detectarHerramientaDocumento(limpio) !== 'imagen' && pareceEdicionDeImagenActiva(limpio)) {"
    verificar(cuerpoAsistenteService.includes(lineaGate), 'Existe un único gate de enrutamiento para materialVisualActivo, con las 4 condiciones combinadas (activo, sin foto, sin voz, no es imagen nueva, sí parece edición)')
    verificar(cuerpoAsistenteService.includes(lineaGate) , "El gate excluye explícitamente los mensajes que nombran una imagen NUEVA (IMAGE_CREATE, detectarHerramientaDocumento(limpio) !== 'imagen') — nunca los trata como edición de la activa")
    verificar(cuerpoAsistenteService.includes(lineaGate), 'El gate exige que el mensaje sea realmente una referencia/instrucción de edición (pareceEdicionDeImagenActiva) — una pregunta sin relación NUNCA entra aquí, cae a la conversación normal de abajo sin tocar materialVisualActivo')
  }
  {
    // Ejecución REAL de pareceEdicionDeImagenActiva/detectarHerramientaDocumento
    // contra el escenario exacto reportado — sin mockear nada, son
    // funciones puras.
    verificar(pareceEdicionDeImagenActiva('Ahora hazla como dibujo para colorear.'), 'IMAGE_EDIT real: "hazla como dibujo para colorear" se detecta como edición')
    verificar(pareceEdicionDeImagenActiva('Ahora vuelve a ponerle color, pero en tonos pastel.'), 'IMAGE_EDIT real: "ponerle color" (conjugación con -erle) se detecta como edición')
    verificar(pareceEdicionDeImagenActiva('Cámbiale el fondo'), 'IMAGE_EDIT real: "Cámbiale" (con acento/mayúscula) se detecta pese a la normalización')
    verificar(pareceEdicionDeImagenActiva('Quítale la mariposa') && pareceEdicionDeImagenActiva('Agrégale un árbol'), 'IMAGE_EDIT real: "Quítale"/"Agrégale" se detectan')
    verificar(detectarHerramientaDocumento('Hazme una imagen de una granja.') === 'imagen', 'IMAGE_CREATE real: "Hazme una imagen de una granja" se detecta como imagen NUEVA (el gate de arriba la excluye de edición)')
    verificar(!pareceEdicionDeImagenActiva('¿Qué materiales necesito para trabajar esta actividad?'), 'Conversación normal real: una pregunta sin relación NO se detecta como edición de imagen — nunca contamina materialVisualActivo')
  }
  verificar(!/this\.actualizarDocumentoActivo\([^)]*\)\s*\n\s*\} else if \(msg && evento\.archivo\)/.test(cuerpoAsistenteService), 'La rama de imagen no cae accidentalmente en actualizarDocumentoActivo (documentoActivo sigue siendo exclusivamente para documentos de texto)')
  verificar(cuerpoAsistenteService.includes('guardarConversacion(this.conversacionActivaId, this.mensajes, this.documentoActivo, this.materialVisualActivo)'), 'materialVisualActivo se persiste junto con la conversación — sobrevive a recargar la app (regla general del proyecto: guardar de forma permanente)')
  verificar(cuerpoAsistenteService.includes('this.materialVisualActivo = datos.materialVisualActivo'), 'abrirConversacion() restaura materialVisualActivo al reabrir una conversación guardada')

  // ============================================================
  // 9. persistencia.ts — campo aditivo/opcional, no rompe
  //    conversaciones guardadas antes de que existiera.
  // ============================================================
  verificar(cuerpoPersistencia.includes('materialVisualActivo?: MaterialVisualActivoGuardado | null'), 'materialVisualActivo es opcional en ConversacionGuardada — conversaciones guardadas antes de esta fase siguen restaurando sin él')

  // ============================================================
  // 10. TarjetaDescarga — la tarjeta SIGUE siendo de solo lectura
  //     (ver CONTENCIÓN DEFINITIVA / suites verificar-tarjetas-sin-
  //     conversion y verificar-documento-planeacion, que ya cubren
  //     esto a fondo): la vista previa de imagen NUEVA no agrega
  //     ningún botón que dispare un mensaje de chat.
  // ============================================================
  {
    const iTarjeta = cuerpoPanel.indexOf('function TarjetaDescarga(')
    const iFinTarjeta = cuerpoPanel.indexOf('\n// Vista previa de solo lectura del documento activo', iTarjeta)
    const cuerpoTarjeta = cuerpoPanel.slice(iTarjeta, iFinTarjeta)
    verificar(cuerpoTarjeta.includes("principal.tipo === 'imagen'") && cuerpoTarjeta.includes('<img'), 'La tarjeta muestra una vista previa real (<img>) cuando el archivo es una imagen')
    verificar(!/sendMessage|handleSend|enviarMensaje|setInput|AsistenteService\./.test(cuerpoTarjeta), 'La vista previa de imagen NO agrega ningún botón/acción que llame a AsistenteService/enviarMensaje — la tarjeta sigue siendo de solo lectura, regenerar se pide escribiendo, igual que editar un documento de texto')
    // Ver "corrección — un asset de tipo imagen no debe llamarse
    // 'Documento activo'": el indicador distingue imagen de documento,
    // sin tocar el resto de la tarjeta (Word/PDF/PowerPoint/Excel
    // conservan el texto de siempre).
    verificar(cuerpoTarjeta.includes("principal.tipo === 'imagen' ? 'Imagen activa' : 'Documento activo'"), '10b. El indicador "activo" dice "Imagen activa" para imágenes y "Documento activo" para el resto — una imagen nunca se rotula como documento')
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
