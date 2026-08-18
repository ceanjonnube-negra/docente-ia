// lib/documentGen/herramientas.ts
//
// Ejecutor server-only de las 7 herramientas de generación de archivos
// (ver sistema de prioridades en lib/asistente/documentos.ts). Solo este
// archivo conoce las 4 librerías reales de generación (docx/pdfkit/
// pptxgenjs/exceljs) — nunca debe importarse desde código de cliente
// (ver app/api/chat/route.ts, el único lugar que lo usa).
//
// Imagen/audio/video están definidas como herramientas (el maestro puede
// pedirlas y el sistema nunca debe fingir que no existen ni responder
// con prosa). Imagen ya tiene proveedor real (ver "Implementar en
// Docente IA la capacidad de generar imágenes...", Fase 0+1,
// lib/imageGen/ImageGenerationService.ts) — audio/video siguen sin
// decidir y lanzan un error honesto en vez de intentar generarlas.
//
// PIPELINE INSTRUMENTADO: cada etapa real se mide y se registra por
// separado (éxito/error + tiempo) para poder localizar EXACTAMENTE dónde
// se rompe la cadena — nunca un solo catch genérico. El maestro nunca ve
// nada de esto (ver MENSAJE_ERROR_DOCUMENTO en app/api/chat/route.ts);
// todo va a console.log/console.error, visible con `vercel logs`.
//
// Nota honesta sobre las 8 etapas que se piden en el diagnóstico: esta
// arquitectura es serverless y todo vive en memoria — nunca se escribe
// un archivo físico a disco antes de subirlo, así que "escritura física"
// no existe como paso separado (el buffer YA es el archivo completo al
// salir de la etapa de conversión). Lo que sí existe, y es el
// equivalente real de "verificar que el archivo existe", es comprobar
// que ese buffer sea un archivo válido (tamaño y firma binaria
// correctos) antes de gastar una subida con algo corrupto.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { TipoHerramienta } from '../asistente/documentos'
import { generarWordBuffer, nombreArchivoWordServidor } from './generarWordServidor'
import { generarPdfBuffer, nombreArchivoPdf } from './generarPdfServidor'
import { generarPptxBuffer, nombreArchivoPptx } from './generarPptxServidor'
import { generarXlsxBuffer, nombreArchivoXlsx } from './generarXlsxServidor'
import { subirBuffer, crearUrlFirmada, descargarBuffer, rutaArchivo, BUCKET_IMAGENES_GENERADAS, type ArchivoGenerado } from './almacenamiento'
import { extraerTitulo, analizarContenido, extraerDescripcionesDeImagen } from './parseContenido'
import { generarImagen, editarImagen } from '../imageGen/ImageGenerationService'
import type { EstiloVisual } from '../imageGen/reglasVisuales'
import { inferirTipoPieza, formatoPorDefectoParaTipoPieza, inferirModoVisual, extraerDatosExplicitosPieza, decidirCalidadCartel } from '../imageGen/reglasVisuales'
import { guardarAssetVisual, obtenerAssetVisualPorId } from '../assetsVisuales'

// Ver "Documentos ilustrados + guías completas e ilustradas", Fase 2A
// — tope duro contra documentos saturados de imágenes (principio "NO
// SATURAR" del diseño aprobado) y contra generaciones lentas/costosas:
// nunca se generan más de esta cantidad de ilustraciones para UN
// documento, sin importar cuántas líneas [[IMAGEN:...]] escriba Claude.
export const MAX_IMAGENES_POR_DOCUMENTO = 4

export class HerramientaNoDisponibleError extends Error {}

// Código corto y diagnosticable (ej. "DOCX-GEN", "PDF-SUB") — nunca un
// mensaje libre. Permite saber de un vistazo en qué ETAPA exacta falló,
// sin exponer detalles internos al maestro (ver mensaje exacto requerido
// en app/api/chat/route.ts).
export class ErrorHerramientaDocumento extends Error {
  constructor(public readonly codigo: string, message: string) {
    super(message)
  }
}

export const ETIQUETA_MODULO: Record<TipoHerramienta, string> = {
  word: 'DOCX',
  pdf: 'PDF',
  powerpoint: 'PPTX',
  excel: 'XLSX',
  imagen: 'IMAGEN',
  audio: 'AUDIO',
  video: 'VIDEO',
}

// Tag de exportación por formato — un grep de "[DOCX_EXPORT]" o
// "[PDF_EXPORT]" en `vercel logs` aísla de un vistazo todas las
// solicitudes de ESE formato, sin mezclarlas con las de los demás.
// Agregar un formato nuevo (xlsx/pptx ya real; odt/csv a futuro) es
// una entrada más aquí — nunca requiere tocar app/api/chat/route.ts,
// que solo conoce TipoHerramienta, nunca un formato específico.
const ETIQUETA_EXPORT: Record<TipoHerramienta, string> = {
  word: 'DOCX_EXPORT',
  pdf: 'PDF_EXPORT',
  powerpoint: 'PPTX_EXPORT',
  excel: 'XLSX_EXPORT',
  imagen: 'IMAGEN_EXPORT',
  audio: 'AUDIO_EXPORT',
  video: 'VIDEO_EXPORT',
}

const CONTENT_TYPES = {
  word: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  powerpoint: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  excel: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
} as const

// Firma binaria esperada al inicio del buffer, según el formato — es lo
// que se verifica en la etapa de "existencia/integridad del archivo"
// (ver nota arriba: no hay disco, se verifica el buffer mismo). docx/
// pptx/xlsx son en realidad archivos ZIP (siempre empiezan con "PK");
// pdf tiene su propia firma "%PDF".
const FIRMA_ESPERADA: Record<'word' | 'pdf' | 'powerpoint' | 'excel', { bytes: number; texto: string }> = {
  word: { bytes: 2, texto: 'PK' },
  powerpoint: { bytes: 2, texto: 'PK' },
  excel: { bytes: 2, texto: 'PK' },
  pdf: { bytes: 4, texto: '%PDF' },
}

// Mide y registra una etapa del pipeline — éxito/error + milisegundos,
// siempre a console.log/console.error (nunca al maestro). `etiqueta` ya
// identifica la herramienta Y la etapa juntas, ej. "DOCX:conversion".
async function medirEtapa<T>(etiqueta: string, fn: () => Promise<T> | T): Promise<T> {
  const inicio = Date.now()
  try {
    const resultado = await fn()
    console.log(`[PIPELINE ${etiqueta}] OK — ${Date.now() - inicio}ms`)
    return resultado
  } catch (err) {
    console.error(`[PIPELINE ${etiqueta}] FALLÓ tras ${Date.now() - inicio}ms:`, err)
    throw err
  }
}

export async function ejecutarHerramientaDocumento(
  tipo: TipoHerramienta,
  texto: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  zonaHoraria: string | null,
  sb: SupabaseClient,
  userId: string,
  // Nuevos, solo usados por tipo==='imagen' (ver "Implementar en
  // Docente IA la capacidad de generar imágenes...", Fase 0+1) —
  // opcionales para no romper los llamadores existentes de
  // word/pdf/powerpoint/excel, que nunca los necesitaron.
  supabaseUser?: SupabaseClient,
  conversacionId?: string | null,
  versionAnteriorId?: string | null,
  // Ver "corrección: timeout en documentos ilustrados largos" — cuando
  // el maestro pide Word Y PDF del mismo documento ilustrado en un
  // solo mensaje, route.ts genera AMBOS formatos y antes cada uno
  // llamaba a este mismo pipeline por separado, así que las MISMAS
  // ilustraciones se generaban dos veces de forma independiente
  // (el doble de tiempo/costo, y con el riesgo real de que Word y PDF
  // terminaran con dibujos distintos para el mismo documento, ya que
  // la generación de imágenes no es determinista). Si quien llama ya
  // generó las imágenes (ver route.ts, CASO 3), las pasa aquí y este
  // pipeline NUNCA vuelve a generarlas — las reutiliza tal cual.
  imagenesPreGeneradas?: Map<string, { buffer: Buffer; ancho: number; alto: number }>,
  // Ver "Ilustraciones por nivel educativo, Fase 1" — resuelto por
  // route.ts con resolverNivelEducativo/obtenerPerfilNivel antes de
  // llamar aquí. undefined (sin nivel resuelto) preserva EXACTAMENTE
  // el comportamiento anterior: generarImagen() cae a su propio
  // ESTILO_POR_DEFECTO, igual que antes de esta fase.
  estiloVisual?: EstiloVisual,
  // FASE 2 — "mejora de calidad visual de imágenes escolares": mensaje
  // REAL del docente (nunca la descripción ya redactada por Claude),
  // solo usado por tipo==='imagen' para inferir tipoPieza de forma
  // determinista (ver inferirTipoPieza) — opcional y al final, para no
  // romper ningún llamador existente. Ausente preserva EXACTAMENTE el
  // camino de antes de esta fase (sin tipoPieza, prompt de siempre).
  mensajeOriginalDocente?: string
): Promise<ArchivoGenerado> {
  // Etapa 1 (detección de la intención) ya ocurrió antes de llegar aquí
  // — ver detectarHerramientaDocumento / FINALIZAR ARCHIVO en
  // app/api/chat/route.ts. Etapa 2 (generación del contenido) también:
  // `texto` ya viene resuelto (recuperado del historial o redactado por
  // Claude en el CASO 3) — ver ese mismo archivo para el registro de esas
  // dos etapas.
  if (tipo === 'audio' || tipo === 'video') {
    console.error(`[PIPELINE ${ETIQUETA_MODULO[tipo]}:deteccion] Herramienta solicitada pero no implementada — falta proveedor.`)
    throw new HerramientaNoDisponibleError(`La generación de ${tipo} todavía no está disponible en esta aplicación — falta elegir proveedor.`)
  }

  if (tipo === 'imagen') {
    return ejecutarGeneracionImagen(texto, perfil, sb, userId, supabaseUser, conversacionId ?? null, versionAnteriorId ?? null, mensajeOriginalDocente)
  }

  console.log(`[${ETIQUETA_EXPORT[tipo]}] userId=${userId} — solicitud de exportación recibida`)

  const etiqueta = ETIQUETA_MODULO[tipo]
  const titulo = extraerTitulo(texto)

  // Documento ilustrado (ver "Documentos ilustrados + guías completas
  // e ilustradas", Fase 2A) — solo word/pdf saben embeber imágenes
  // (ver construirDocumentoWord.ts/generarPdfServidor.ts); powerpoint/
  // excel ignoran las líneas [[IMAGEN:...]] (fuera de alcance, ver
  // parseContenido.ts). Si el texto no trae ninguna línea de imagen,
  // este bloque no hace NADA — un documento normal sigue el camino
  // exacto de siempre, sin ninguna llamada extra.
  let imagenesPorDescripcion: Map<string, { buffer: Buffer; ancho: number; alto: number }> | undefined = imagenesPreGeneradas
  if (!imagenesPorDescripcion && (tipo === 'word' || tipo === 'pdf')) {
    const descripciones = extraerDescripcionesDeImagen(analizarContenido(texto)).slice(0, MAX_IMAGENES_POR_DOCUMENTO)
    if (descripciones.length > 0) {
      imagenesPorDescripcion = await generarImagenesParaDocumento(descripciones, perfil, sb, userId, supabaseUser, conversacionId ?? null, estiloVisual)
    }
  }

  const generadores = {
    word: async () => ({ buffer: await generarWordBuffer(texto, perfil, zonaHoraria, imagenesPorDescripcion), nombre: nombreArchivoWordServidor(titulo) }),
    pdf: async () => ({ buffer: await generarPdfBuffer(texto, perfil, zonaHoraria, imagenesPorDescripcion), nombre: nombreArchivoPdf(titulo) }),
    powerpoint: async () => ({ buffer: await generarPptxBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoPptx(titulo) }),
    excel: async () => ({ buffer: await generarXlsxBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoXlsx(titulo) }),
  } as const

  // ETAPA 3: conversión al formato real (.docx/.pdf/.pptx/.xlsx) — el
  // buffer que sale de aquí YA ES el archivo completo, de principio a
  // fin, armado en memoria.
  let buffer: Buffer
  let nombre: string
  try {
    ;({ buffer, nombre } = await medirEtapa(`${etiqueta}:conversion`, generadores[tipo]))
  } catch {
    throw new ErrorHerramientaDocumento(`${etiqueta}-GEN`, `Fallo generando el archivo ${tipo}`)
  }

  // ETAPAS 4 y 5 combinadas (escritura física / verificación de
  // existencia): no hay disco en esta arquitectura — lo que se verifica
  // es que el buffer resultante sea un archivo real y válido (tamaño
  // razonable + firma binaria correcta) antes de gastar una subida con
  // algo corrupto.
  try {
    medirEtapaSync(`${etiqueta}:verificacion`, () => {
      if (!buffer || buffer.length === 0) throw new Error('El buffer generado está vacío')
      const firma = FIRMA_ESPERADA[tipo]
      const inicioBuffer = buffer.subarray(0, firma.bytes).toString('latin1')
      if (inicioBuffer !== firma.texto) {
        throw new Error(`Firma de archivo inesperada: se esperaba "${firma.texto}", se obtuvo "${inicioBuffer}"`)
      }
    })
  } catch (err) {
    console.error(`[PIPELINE ${etiqueta}:verificacion] Buffer inválido tras la conversión:`, err)
    throw new ErrorHerramientaDocumento(`${etiqueta}-VERIF`, `El archivo ${tipo} generado no es válido`)
  }

  // ETAPA 6: subida a Supabase Storage.
  const ruta = rutaArchivo(userId, nombre)
  try {
    await medirEtapa(`${etiqueta}:subida`, () => subirBuffer(sb, ruta, buffer, CONTENT_TYPES[tipo]))
    console.log(`[UPLOAD] ${etiqueta} — ${nombre} subido a Storage`)
  } catch (err) {
    console.error(`[UPLOAD] ${etiqueta} — fallo subiendo ${nombre}:`, err)
    throw new ErrorHerramientaDocumento(`${etiqueta}-SUB`, `Fallo subiendo el archivo ${tipo}`)
  }

  // ETAPA 7: obtención de la URL (firmada, nunca pública — ver
  // almacenamiento.ts).
  let url: string
  try {
    url = await medirEtapa(`${etiqueta}:url-firmada`, () => crearUrlFirmada(sb, ruta, nombre))
    console.log(`[SIGNED_URL] ${etiqueta} — URL firmada obtenida para ${nombre}`)
  } catch (err) {
    console.error(`[SIGNED_URL] ${etiqueta} — fallo obteniendo la URL de ${nombre}:`, err)
    throw new ErrorHerramientaDocumento(`${etiqueta}-URL`, `Fallo obteniendo la URL de descarga del ${tipo}`)
  }

  // ETAPA 7.5: verificación de accesibilidad real — nunca se responde
  // éxito solo porque Storage aceptó la subida y devolvió una URL
  // firmada; se comprueba que esa URL exacta, la que va a recibir el
  // maestro, de verdad sirve el archivo antes de decir "listo".
  try {
    await medirEtapa(`${etiqueta}:verificacion-url`, async () => {
      const res = await fetch(url, { method: 'HEAD' })
      if (!res.ok) throw new Error(`HEAD a la URL firmada respondió ${res.status}`)
    })
  } catch (err) {
    console.error(`[PIPELINE ${etiqueta}:verificacion-url] La URL firmada no quedó accesible:`, err)
    throw new ErrorHerramientaDocumento(`${etiqueta}-URL-VERIF`, `La URL de descarga del ${tipo} no quedó accesible`)
  }

  console.log(`[DOWNLOAD_READY] ${etiqueta} — ${nombre} verificado y listo para el maestro`)

  // ETAPA 7.6 (solo pdf) — segunda URL firmada del MISMO archivo, SIN
  // `download` (CORRECCIÓN AISLADA — "separar 'Ver PDF' de 'Descargar
  // PDF'"): TarjetaDescarga la usa para el botón "Ver PDF" (abre el
  // pdf en el visor del navegador) — nunca sustituye a `url`, que
  // sigue siendo la URL de descarga forzada de siempre. Mejor
  // esfuerzo: si falla, se omite urlVer y el documento sigue siendo
  // válido (solo con descarga, como antes de este ajuste) — nunca
  // bloquea la entrega del archivo ya generado y verificado.
  let urlVer: string | undefined
  if (tipo === 'pdf') {
    try {
      urlVer = await medirEtapa(`${etiqueta}:url-firmada-ver`, () => crearUrlFirmada(sb, ruta))
    } catch (err) {
      console.error(`[PIPELINE ${etiqueta}:url-firmada-ver] No se pudo generar la URL de visualización (no bloquea):`, err)
    }
  }

  // ETAPA 8 (entrega al usuario) ocurre en app/api/chat/route.ts, al
  // devolver este resultado envuelto en el marcador
  // [[DOCUMENTO_ARCHIVO:...]] — se registra ahí mismo. tamanoBytes sale
  // gratis (buffer.length ya se calculó arriba para la verificación de
  // firma) — lo usa la tarjeta universal del Chat IA para mostrar el
  // tamaño real sin pedirle nada más a Storage.
  return { tipo, nombre, url, tamanoBytes: buffer.length, urlVer }
}

// Genera + sube + persiste UNA ilustración para un documento (ver
// "Documentos ilustrados + guías completas e ilustradas", Fase 2A) —
// aislada de ejecutarGeneracionImagen (imagen SUELTA del chat) porque
// esta nunca se entrega como su propia tarjeta ni acepta edición
// directa todavía (eso es Fase 2B): solo produce el buffer que
// construirDocumentoWord.ts/generarPdfServidor.ts necesitan para
// embeber, y dejan un registro real en assets_visuales
// (tipo_uso='ilustracion_documento') para poder asociarla/editarla
// más adelante sin duplicar generación.
async function generarUnaIlustracion(
  descripcion: string,
  orden: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  sb: SupabaseClient,
  userId: string,
  supabaseUser: SupabaseClient | undefined,
  conversacionId: string | null,
  // Ver "Ilustraciones por nivel educativo, Fase 1" — undefined
  // preserva el ESTILO_POR_DEFECTO de siempre, sin cambiar nada.
  estiloVisual: EstiloVisual | undefined
): Promise<{ descripcion: string; buffer: Buffer; ancho: number; alto: number } | null> {
  let imagen: Awaited<ReturnType<typeof generarImagen>>
  try {
    imagen = await medirEtapa(`IMAGEN-DOC:generacion[${orden}]`, () => generarImagen({ prompt: descripcion, nivelEscolar: perfil?.grado || undefined, estilo: estiloVisual }))
  } catch (err) {
    console.error(`[PIPELINE IMAGEN-DOC:generacion] Falló generando la ilustración ${orden} ("${descripcion.slice(0, 60)}"):`, err)
    return null
  }

  const nombre = `Ilustracion_${Date.now()}_${orden}.png`
  const ruta = rutaArchivo(userId, nombre)
  try {
    await medirEtapa(`IMAGEN-DOC:subida[${orden}]`, () => subirBuffer(sb, ruta, imagen.buffer, imagen.contentType, BUCKET_IMAGENES_GENERADAS))
  } catch (err) {
    console.error(`[PIPELINE IMAGEN-DOC:subida] Falló subiendo la ilustración ${orden}:`, err)
    return null
  }

  // Persistencia — mismo criterio de "mejor esfuerzo" que
  // ejecutarGeneracionImagen: si falla, la imagen YA está subida y se
  // puede embeber igual; solo se pierde poder asociarla/editarla
  // después.
  if (supabaseUser) {
    try {
      await medirEtapa(`IMAGEN-DOC:persistencia[${orden}]`, () =>
        guardarAssetVisual(supabaseUser, {
          docenteId: userId,
          conversacionId,
          tipo: 'imagen',
          formatoArchivo: 'png',
          promptOriginal: imagen.promptUsado,
          storagePath: ruta,
          tamanoBytes: imagen.buffer.length,
          grado: perfil?.grado || null,
          grupo: perfil?.grupo || null,
        })
      )
    } catch (err) {
      console.error(`[PIPELINE IMAGEN-DOC:persistencia] No se pudo guardar el registro de la ilustración ${orden} (no bloquea):`, err)
    }
  }

  return { descripcion, buffer: imagen.buffer, ancho: imagen.ancho, alto: imagen.alto }
}

// Genera todas las ilustraciones que un documento necesita, en
// paralelo (ya acotadas a MAX_IMAGENES_POR_DOCUMENTO por quien llama).
// Una ilustración que falla simplemente no aparece en el mapa — nunca
// tumba la generación del documento completo (ver dibujarImagen en
// generarPdfServidor.ts / la rama esImagen en construirDocumentoWord.ts,
// ambas omiten en silencio una descripción sin imagen en el mapa).
// Exportada (ver "corrección: timeout en documentos ilustrados
// largos") para que route.ts pueda generarlas UNA sola vez y pasar el
// mismo mapa a cada formato pedido (Word y PDF) vía imagenesPreGeneradas
// en ejecutarHerramientaDocumento — nunca duplica la generación.
export async function generarImagenesParaDocumento(
  descripciones: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  sb: SupabaseClient,
  userId: string,
  supabaseUser: SupabaseClient | undefined,
  conversacionId: string | null,
  estiloVisual?: EstiloVisual
): Promise<Map<string, { buffer: Buffer; ancho: number; alto: number }>> {
  const resultados = await Promise.all(
    descripciones.map((descripcion, orden) => generarUnaIlustracion(descripcion, orden, perfil, sb, userId, supabaseUser, conversacionId, estiloVisual))
  )
  const mapa = new Map<string, { buffer: Buffer; ancho: number; alto: number }>()
  for (const r of resultados) {
    if (r) mapa.set(r.descripcion, { buffer: r.buffer, ancho: r.ancho, alto: r.alto })
  }
  return mapa
}

// Generación de imagen suelta (ver "Implementar en Docente IA la
// capacidad de generar imágenes...", Fase 0+1) — mismo pipeline
// instrumentado por etapas que word/pdf/powerpoint/excel arriba, pero
// aparte: no hay conversión de texto a archivo (la "conversión" es la
// llamada real al proveedor de imágenes) y agrega una etapa nueva
// (persistencia en assets_visuales) que los demás formatos no tienen.
async function ejecutarGeneracionImagen(
  prompt: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  perfil: any,
  sb: SupabaseClient,
  userId: string,
  supabaseUser: SupabaseClient | undefined,
  conversacionId: string | null,
  versionAnteriorId: string | null,
  // FASE 2 — mensaje REAL del docente (nunca la descripción de
  // Claude) — SOLO se usa para inferir tipoPieza de forma
  // determinista, nunca como contenido del prompt.
  mensajeOriginalDocente?: string
): Promise<ArchivoGenerado> {
  console.log(`[IMAGEN_EXPORT] userId=${userId} — solicitud de ${versionAnteriorId ? 'EDICIÓN' : 'generación'} de imagen recibida`)

  // EDICIÓN real (ver "corrección — edición real de imágenes con el
  // asset visual anterior como entrada"): con versionAnteriorId, la
  // imagen ORIGINAL (el archivo real, descargado de Storage) viaja
  // como entrada visual al proveedor — nunca se regenera desde cero
  // con texto, así se conserva la composición real en vez de
  // reinterpretar la escena. `prompt` aquí es la instrucción corta del
  // maestro ("hazla más colorida"), no un prompt recompuesto.
  let imagen: Awaited<ReturnType<typeof generarImagen>>
  if (versionAnteriorId) {
    if (!supabaseUser) throw new ErrorHerramientaDocumento('IMAGEN-EDIT-SESION', 'No fue posible identificar la sesión para editar la imagen')
    const assetAnterior = await obtenerAssetVisualPorId(supabaseUser, versionAnteriorId)
    if (!assetAnterior) throw new ErrorHerramientaDocumento('IMAGEN-EDIT-NOENCONTRADO', 'No se encontró la imagen original a editar')
    let bufferOriginal: Buffer
    try {
      bufferOriginal = await medirEtapa('IMAGEN:descarga-original', () => descargarBuffer(sb, assetAnterior.storagePath, BUCKET_IMAGENES_GENERADAS))
    } catch (err) {
      console.error('[PIPELINE IMAGEN:descarga-original] Falló descargando la imagen original a editar:', err)
      throw new ErrorHerramientaDocumento('IMAGEN-EDIT-DESCARGA', 'Fallo recuperando la imagen original a editar')
    }
    try {
      imagen = await medirEtapa('IMAGEN:edicion', () => editarImagen(bufferOriginal, prompt))
    } catch (err) {
      console.error('[PIPELINE IMAGEN:edicion] Falló editando la imagen:', err)
      throw new ErrorHerramientaDocumento('IMAGEN-GEN', 'Fallo editando la imagen')
    }
  } else {
    // FASE 1/2/3 — "mejora de calidad visual de imágenes escolares":
    // tipoPieza se infiere SOLO del mensaje real del docente (nunca de
    // la descripción de Claude en `prompt`, que puede parafrasear y
    // perder las palabras clave), de forma 100% determinista — ver
    // inferirTipoPieza. Sin mensajeOriginalDocente (llamador que no lo
    // pasa), tipoPieza queda undefined y construirPromptFinal cae
    // exactamente en el camino de siempre, sin ningún cambio.
    const tipoPieza = mensajeOriginalDocente ? inferirTipoPieza(mensajeOriginalDocente) : undefined
    const formato = tipoPieza ? formatoPorDefectoParaTipoPieza(tipoPieza) : undefined
    // "dos modos visuales" / "no inventar datos" / "optimización de
    // costo": las 3 mejoras siguen el MISMO criterio que tipoPieza —
    // solo se calculan cuando hay tipoPieza Y mensaje real del
    // docente; sin eso, quedan undefined y construirPromptFinal/
    // generarImagen se comportan exactamente igual que antes.
    const modoVisual = tipoPieza && mensajeOriginalDocente ? inferirModoVisual(tipoPieza, mensajeOriginalDocente) : undefined
    const datosExplicitos = tipoPieza && mensajeOriginalDocente ? extraerDatosExplicitosPieza(mensajeOriginalDocente) : undefined
    const calidad = tipoPieza && mensajeOriginalDocente ? decidirCalidadCartel(mensajeOriginalDocente, datosExplicitos ?? {}) : undefined
    try {
      // CORRECCIÓN — "fuente de verdad completa": se pasa el mensaje
      // REAL del docente completo (no solo el subconjunto estructurado
      // datosExplicitos) para que construirPromptCartelEscolar pueda
      // conservar hechos reales que no caben en fecha/hora/lugar/costo
      // (ej. "Jornada Ampliada", "pago trimestral") sin perderlos.
      imagen = await medirEtapa('IMAGEN:generacion', () => generarImagen({ prompt, tipoPieza, formato, modoVisual, datosExplicitos, calidad, mensajeOriginalDocente }))
    } catch (err) {
      console.error('[PIPELINE IMAGEN:generacion] Falló generando la imagen:', err)
      throw new ErrorHerramientaDocumento('IMAGEN-GEN', 'Fallo generando la imagen')
    }
  }

  try {
    medirEtapaSync('IMAGEN:verificacion', () => {
      if (!imagen.buffer || imagen.buffer.length === 0) throw new Error('El buffer generado está vacío')
      const firma = imagen.buffer.subarray(0, 4)
      // Firma binaria real de PNG (0x89 'P' 'N' 'G') — mismo criterio
      // que FIRMA_ESPERADA arriba, comparación byte a byte porque el
      // primer byte (0x89) no es un carácter ASCII imprimible.
      if (firma[0] !== 0x89 || firma[1] !== 0x50 || firma[2] !== 0x4e || firma[3] !== 0x47) {
        throw new Error('Firma de archivo inesperada: no es un PNG válido')
      }
    })
  } catch (err) {
    console.error('[PIPELINE IMAGEN:verificacion] Buffer inválido tras la generación:', err)
    throw new ErrorHerramientaDocumento('IMAGEN-VERIF', 'La imagen generada no es válida')
  }

  const nombre = `Imagen_${Date.now()}.png`
  const ruta = rutaArchivo(userId, nombre)
  try {
    await medirEtapa('IMAGEN:subida', () => subirBuffer(sb, ruta, imagen.buffer, imagen.contentType, BUCKET_IMAGENES_GENERADAS))
    console.log(`[UPLOAD] IMAGEN — ${nombre} subido a Storage`)
  } catch (err) {
    console.error(`[UPLOAD] IMAGEN — fallo subiendo ${nombre}:`, err)
    throw new ErrorHerramientaDocumento('IMAGEN-SUB', 'Fallo subiendo la imagen')
  }

  let url: string
  try {
    url = await medirEtapa('IMAGEN:url-firmada', () => crearUrlFirmada(sb, ruta, nombre, BUCKET_IMAGENES_GENERADAS))
    console.log(`[SIGNED_URL] IMAGEN — URL firmada obtenida para ${nombre}`)
  } catch (err) {
    console.error(`[SIGNED_URL] IMAGEN — fallo obteniendo la URL de ${nombre}:`, err)
    throw new ErrorHerramientaDocumento('IMAGEN-URL', 'Fallo obteniendo la URL de la imagen')
  }

  try {
    await medirEtapa('IMAGEN:verificacion-url', async () => {
      const res = await fetch(url, { method: 'HEAD' })
      if (!res.ok) throw new Error(`HEAD a la URL firmada respondió ${res.status}`)
    })
  } catch (err) {
    console.error('[PIPELINE IMAGEN:verificacion-url] La URL firmada no quedó accesible:', err)
    throw new ErrorHerramientaDocumento('IMAGEN-URL-VERIF', 'La URL de la imagen no quedó accesible')
  }

  // Persistencia en assets_visuales — mejor esfuerzo real: si esto
  // falla, la imagen YA está subida, verificada y accesible (lo que
  // importa para el docente en este turno); lo único que se pierde es
  // poder "regenerar" a partir de ella más tarde, nunca la imagen en
  // sí. Requiere el cliente AUTENTICADO del docente (RLS), nunca
  // service_role — mismo criterio que lib/turnosChat.ts.
  let assetId: string | undefined
  if (supabaseUser) {
    try {
      const guardado = await medirEtapa('IMAGEN:persistencia', () =>
        guardarAssetVisual(supabaseUser, {
          docenteId: userId,
          conversacionId,
          tipo: 'imagen',
          formatoArchivo: 'png',
          promptOriginal: imagen.promptUsado,
          storagePath: ruta,
          tamanoBytes: imagen.buffer.length,
          grado: perfil?.grado || null,
          grupo: perfil?.grupo || null,
          versionAnteriorId,
        })
      )
      assetId = guardado.id
    } catch (err) {
      console.error('[PIPELINE IMAGEN:persistencia] No se pudo guardar el registro del asset visual (no bloquea la entrega):', err)
    }
  }

  console.log(`[DOWNLOAD_READY] IMAGEN — ${nombre} verificado y listo para el maestro`)
  return { tipo: 'imagen', nombre, url, tamanoBytes: imagen.buffer.length, assetId }
}

function medirEtapaSync<T>(etiqueta: string, fn: () => T): T {
  const inicio = Date.now()
  try {
    const resultado = fn()
    console.log(`[PIPELINE ${etiqueta}] OK — ${Date.now() - inicio}ms`)
    return resultado
  } catch (err) {
    console.error(`[PIPELINE ${etiqueta}] FALLÓ tras ${Date.now() - inicio}ms:`, err)
    throw err
  }
}
