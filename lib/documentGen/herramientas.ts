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
  userId: string
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

  const etiqueta = ETIQUETA_MODULO[tipo]
  const titulo = extraerTitulo(texto)
  const generadores = {
    word: async () => ({ buffer: await generarWordBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoWordServidor(titulo) }),
    pdf: async () => ({ buffer: await generarPdfBuffer(texto, perfil, zonaHoraria), nombre: nombreArchivoPdf(titulo) }),
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
  } catch {
    throw new ErrorHerramientaDocumento(`${etiqueta}-SUB`, `Fallo subiendo el archivo ${tipo}`)
  }

  // ETAPA 7: obtención de la URL (firmada, nunca pública — ver
  // almacenamiento.ts).
  let url: string
  try {
    url = await medirEtapa(`${etiqueta}:url-firmada`, () => crearUrlFirmada(sb, ruta))
  } catch {
    throw new ErrorHerramientaDocumento(`${etiqueta}-URL`, `Fallo obteniendo la URL de descarga del ${tipo}`)
  }

  // ETAPA 8 (entrega al usuario) ocurre en app/api/chat/route.ts, al
  // devolver este resultado envuelto en el marcador
  // [[DOCUMENTO_ARCHIVO:...]] — se registra ahí mismo.
  return { tipo, nombre, url }
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
