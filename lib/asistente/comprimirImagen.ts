// lib/asistente/comprimirImagen.ts
//
// Compresión client-side antes de enviar varias fotos en un solo
// mensaje del Chat IA — necesaria porque Vercel limita el cuerpo de
// una función serverless a 4.5MB (este proyecto no lo tiene
// configurado más alto: es el límite real de la plataforma, no un
// capricho). 10-20 fotos de celular sin comprimir (típicamente 3-9MB
// cada una) jamás caben en ese límite. Usa <canvas>, sin librerías
// nuevas — el mismo enfoque que cualquier compresor de imágenes del
// lado del navegador.

export type ImagenComprimida = { base64: string; tipo: string }

const DIMENSION_MAXIMA_PX = 1600
// Se intenta en orden hasta que el resultado quepa en el presupuesto
// por imagen — así una foto compleja (muchos detalles/colores) se
// comprime más que una simple, en vez de una calidad fija que a veces
// se queda corta y a veces sacrifica nitidez sin necesidad.
const CALIDADES_JPEG = [0.75, 0.6, 0.45, 0.3]
// 190KB binario por imagen — base64 lo infla ~1.37x (4/3 más el
// escape dentro del JSON), así que 12 fotos a este tamaño ocupan
// ~3.1MB de las 3.2MB de presupuesto total de abajo. Estos tres
// números (tamaño por imagen, presupuesto total, tope de imágenes)
// están calculados juntos a propósito — cambiar uno sin recalcular
// los otros dos puede volver a dejar que un mensaje válido según este
// archivo sea rechazado por Vercel de todos modos.
// Exportado (además de usado internamente) para que
// scripts/verificar-multiples-imagenes.ts pueda comprobar que este
// número, MAXIMO_IMAGENES_POR_MENSAJE y PRESUPUESTO_TOTAL_BASE64_BYTES
// siguen siendo consistentes entre sí cada vez que alguno cambie.
export const TAMANIO_MAXIMO_BYTES_POR_IMAGEN = 190_000

// Deja margen real bajo el límite de 4.5MB de Vercel (sin configurar
// en este proyecto — es el límite real de la plataforma, no un
// capricho): el mensaje de texto, el historial de la conversación y
// el overhead del propio JSON también ocupan espacio en el mismo
// cuerpo de la petición.
export const PRESUPUESTO_TOTAL_BASE64_BYTES = 3_200_000
// La ambición original era "10-20 fotos" — con el límite real de
// Vercel y una compresión que mantenga las fotos legibles (para poder
// leer un calendario, una lista o un documento fotografiado), 12 es el
// número real que cabe con margen. Pedir más simplemente no es
// posible sin cambiar el límite de la función en Vercel (fuera del
// alcance de "reforzar sobre la arquitectura actual").
export const MAXIMO_IMAGENES_POR_MENSAJE = 12

function cargarImagen(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('No se pudo leer la imagen'))
    }
    img.src = url
  })
}

function blobABase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve((reader.result as string).split(',')[1])
    reader.onerror = () => reject(new Error('No se pudo procesar la imagen'))
    reader.readAsDataURL(blob)
  })
}

function canvasABlob(canvas: HTMLCanvasElement, calidad: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', calidad))
}

// Redimensiona (nunca agranda una imagen pequeña) al lado más largo y
// recodifica JPEG con calidad adaptativa. Nunca bloquea el envío por
// una sola foto problemática (HEIC no decodificable en este
// navegador, archivo dañado, etc.) — en ese caso se usa el archivo
// original sin comprimir; el presupuesto total del mensaje
// (verificarPresupuestoAdjuntos) sigue protegiendo contra un envío
// condenado a fallar por tamaño.
export async function comprimirImagen(file: File): Promise<ImagenComprimida> {
  try {
    const img = await cargarImagen(file)
    const escala = Math.min(1, DIMENSION_MAXIMA_PX / Math.max(img.width, img.height))
    const ancho = Math.max(1, Math.round(img.width * escala))
    const alto = Math.max(1, Math.round(img.height * escala))

    const canvas = document.createElement('canvas')
    canvas.width = ancho
    canvas.height = alto
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('No se pudo preparar la imagen')
    ctx.drawImage(img, 0, 0, ancho, alto)

    let mejorBlob: Blob | null = null
    for (const calidad of CALIDADES_JPEG) {
      const blob = await canvasABlob(canvas, calidad)
      if (!blob) continue
      mejorBlob = blob
      if (blob.size <= TAMANIO_MAXIMO_BYTES_POR_IMAGEN) break
    }
    if (!mejorBlob) throw new Error('No se pudo comprimir la imagen')

    return { base64: await blobABase64(mejorBlob), tipo: 'image/jpeg' }
  } catch {
    const base64 = await blobABase64(file)
    return { base64, tipo: file.type || 'image/jpeg' }
  }
}

// Secuencial a propósito, no Promise.all: da un progreso real (X de N,
// ver onProgreso) en vez de uno inventado, y evita picos de memoria/CPU
// decodificando y recodificando muchas fotos grandes al mismo tiempo
// en un celular de gama baja — cada `await` cede el hilo principal
// entre una imagen y la siguiente, así que la interfaz nunca se
// congela mientras dura.
export async function comprimirImagenes(
  files: File[],
  onProgreso?: (completadas: number, total: number) => void
): Promise<ImagenComprimida[]> {
  const resultados: ImagenComprimida[] = []
  for (let i = 0; i < files.length; i++) {
    resultados.push(await comprimirImagen(files[i]))
    onProgreso?.(i + 1, files.length)
  }
  return resultados
}

export function verificarPresupuestoAdjuntos(imagenes: ImagenComprimida[]): { cabe: boolean; bytesTotales: number } {
  const bytesTotales = imagenes.reduce((acc, img) => acc + img.base64.length, 0)
  return { cabe: bytesTotales <= PRESUPUESTO_TOTAL_BASE64_BYTES, bytesTotales }
}
