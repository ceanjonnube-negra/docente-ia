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
// con prosa) pero todavía no tienen proveedor/costo decidido — lanzan un
// error honesto en vez de intentar generarlas.
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
import { subirBuffer, crearUrlFirmada, rutaArchivo, type ArchivoGenerado } from './almacenamiento'
import { clasificarArchivo, confirmarArchivo, marcarArchivoFallido, registrarArchivo, type RegistroArchivoSolicitado } from './registroArchivos'
import { extraerTitulo } from './parseContenido'

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
  // Solo PowerPoint nuevo (CASO 3 en /api/chat): cantidad de secciones
  // pedida por el docente. Sin ella (conversiones), nada cambia.
  // registro: clasificación del archivo en archivos_generados (etapa
  // 3B-2A). Sin ella el archivo queda como 'conservar' (protegido); solo
  // una señal estructurada ({ clase: 'efimero', conversacionId }) lo hace
  // efímero, nunca el texto del documento (ver clasificarArchivo).
  opciones?: { seccionesEsperadas?: number; registro?: RegistroArchivoSolicitado }
): Promise<ArchivoGenerado> {
  // Etapa 1 (detección de la intención) ya ocurrió antes de llegar aquí
  // — ver detectarHerramientaDocumento / FINALIZAR ARCHIVO en
  // app/api/chat/route.ts. Etapa 2 (generación del contenido) también:
  // `texto` ya viene resuelto (recuperado del historial o redactado por
  // Claude en el CASO 3) — ver ese mismo archivo para el registro de esas
  // dos etapas.
  if (tipo === 'imagen' || tipo === 'audio' || tipo === 'video') {
    console.error(`[PIPELINE ${ETIQUETA_MODULO[tipo]}:deteccion] Herramienta solicitada pero no implementada — falta proveedor.`)
    throw new HerramientaNoDisponibleError(`La generación de ${tipo} todavía no está disponible en esta aplicación — falta elegir proveedor.`)
  }

  console.log(`[${ETIQUETA_EXPORT[tipo]}] userId=${userId} — solicitud de exportación recibida`)

  const etiqueta = ETIQUETA_MODULO[tipo]
  const titulo = extraerTitulo(texto)
  const generadores = {
    word: async () => ({ buffer: await generarWordBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoWordServidor(titulo) }),
    pdf: async () => ({ buffer: await generarPdfBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoPdf(titulo) }),
    powerpoint: async () => ({ buffer: await generarPptxBuffer(texto, perfil, zonaHoraria, opciones?.seccionesEsperadas), nombre: nombreArchivoPptx(titulo) }),
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

  // ETAPA 5.5: registro previo (archivos_generados, 'subiendo'). Si no se
  // puede registrar, no se sube nada: nunca hay archivos sin registro.
  const ruta = rutaArchivo(userId, nombre)
  let archivoId: string
  try {
    ;({ id: archivoId } = await medirEtapa(`${etiqueta}:registro`, () => registrarArchivo({
      docenteId: userId,
      ruta,
      nombre,
      tipoMime: CONTENT_TYPES[tipo],
      tamanoBytes: buffer.length,
      ...clasificarArchivo(opciones?.registro),
    })))
  } catch (err) {
    console.error(`[REGISTRO] ${etiqueta} — no se pudo registrar ${nombre} (no se sube):`, err)
    throw new ErrorHerramientaDocumento(`${etiqueta}-REG`, `Fallo registrando el archivo ${tipo}`)
  }

  // Desde aquí, cualquier fallo marca el registro como 'fallido' (nunca
  // entregado). Cada etapa se recupera sobre la MISMA ruta antes de
  // rendirse: un reintento nunca vuelve a generar ni a subir un archivo
  // que ya está en Storage.
  try {
    // ETAPA 6: subida a Supabase Storage.
    try {
      await medirEtapa(`${etiqueta}:subida`, () => reintentarEtapa(async (intento) => {
        try {
          await subirBuffer(sb, ruta, buffer, CONTENT_TYPES[tipo])
        } catch (err) {
          // Una subida anterior de ESTA misma operación sí llegó (respuesta
          // perdida): el objeto ya existe en esta ruta única. La
          // verificación de la ETAPA 7.5 confirma que es accesible.
          if (intento > 1 && /already exists|duplicate|409/i.test(String((err as { message?: string })?.message ?? err))) return
          throw err
        }
      }, 2))
      console.log(`[UPLOAD] ${etiqueta} — ${nombre} subido a Storage`)
    } catch (err) {
      console.error(`[UPLOAD] ${etiqueta} — fallo subiendo ${nombre}:`, err)
      throw new ErrorHerramientaDocumento(`${etiqueta}-SUB`, `Fallo subiendo el archivo ${tipo}`)
    }

    // ETAPA 7: obtención de la URL (firmada, nunca pública — ver
    // almacenamiento.ts).
    let url: string
    try {
      url = await medirEtapa(`${etiqueta}:url-firmada`, () => reintentarEtapa(() => crearUrlFirmada(sb, ruta, nombre), 3))
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
      await medirEtapa(`${etiqueta}:verificacion-url`, () => reintentarEtapa(async () => {
        const res = await fetch(url, { method: 'HEAD' })
        if (!res.ok) throw new Error(`HEAD a la URL firmada respondió ${res.status}`)
      }, 3))
    } catch (err) {
      console.error(`[PIPELINE ${etiqueta}:verificacion-url] La URL firmada no quedó accesible:`, err)
      throw new ErrorHerramientaDocumento(`${etiqueta}-URL-VERIF`, `La URL de descarga del ${tipo} no quedó accesible`)
    }

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

    // ETAPA 7.7: confirmación del registro ('activo'). confirmarArchivo
    // ya reintenta y reconoce una confirmación previa cuya respuesta se
    // perdió; si aun así no se confirma, el archivo NO se entrega.
    try {
      await medirEtapa(`${etiqueta}:confirmacion-registro`, () => confirmarArchivo(archivoId))
    } catch (err) {
      console.error(`[REGISTRO] ${etiqueta} — no se pudo confirmar el registro de ${nombre}:`, err)
      throw new ErrorHerramientaDocumento(`${etiqueta}-REG-CONF`, `Fallo confirmando el registro del archivo ${tipo}`)
    }

    console.log(`[DOWNLOAD_READY] ${etiqueta} — ${nombre} verificado, registrado y listo para el maestro`)

  // ETAPA 8 (entrega al usuario) ocurre en app/api/chat/route.ts, al
  // devolver este resultado envuelto en el marcador
  // [[DOCUMENTO_ARCHIVO:...]] — se registra ahí mismo. tamanoBytes sale
  // gratis (buffer.length ya se calculó arriba para la verificación de
  // firma) — lo usa la tarjeta universal del Chat IA para mostrar el
  // tamaño real sin pedirle nada más a Storage.
    return { tipo, nombre, url, tamanoBytes: buffer.length, urlVer, archivoId }
  } catch (err) {
    await marcarArchivoFallido(archivoId, err)
    throw err
  }
}

// Repite una etapa sobre el MISMO archivo (sin regenerar nada) ante
// fallos transitorios de red o de Storage.
async function reintentarEtapa<T>(fn: (intento: number) => Promise<T>, intentos: number): Promise<T> {
  let ultimo: unknown
  for (let i = 1; i <= intentos; i++) {
    try {
      return await fn(i)
    } catch (err) {
      ultimo = err
      if (i < intentos) await new Promise((r) => setTimeout(r, 250 * i))
    }
  }
  throw ultimo
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
