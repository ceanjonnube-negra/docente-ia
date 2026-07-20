// scripts/verificar-multiples-imagenes.ts
//
// Prueba aislada (sin navegador — <canvas>/Image no existen en Node,
// así que la compresión en sí solo puede probarse en el dispositivo
// real) de la parte de "Implementar soporte completo para múltiples
// fotografías" que SÍ es lógica pura: que el presupuesto de payload
// nunca deje pasar un mensaje que Vercel rechazaría (límite real de
// 4.5MB, sin configurar en este proyecto), y que las tres constantes
// (tamaño máximo por imagen, presupuesto total, tope de imágenes) sean
// consistentes entre sí. Se ejecuta con
// `npx tsx scripts/verificar-multiples-imagenes.ts`.

import {
  verificarPresupuestoAdjuntos,
  PRESUPUESTO_TOTAL_BASE64_BYTES,
  MAXIMO_IMAGENES_POR_MENSAJE,
  TAMANIO_MAXIMO_BYTES_POR_IMAGEN,
} from '../lib/asistente/comprimirImagen'
import type { ImagenComprimida } from '../lib/asistente/comprimirImagen'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// --- Límite real de Vercel: nunca debe ser posible construir, con las
// constantes actuales, un mensaje que supere el límite de la
// plataforma (4.5MB) incluso antes de sumar texto/historial. ---
const LIMITE_REAL_VERCEL_BYTES = 4_500_000
verificar(
  PRESUPUESTO_TOTAL_BASE64_BYTES < LIMITE_REAL_VERCEL_BYTES,
  `El presupuesto (${(PRESUPUESTO_TOTAL_BASE64_BYTES / 1e6).toFixed(2)}MB) deja margen real bajo el límite de Vercel (${(LIMITE_REAL_VERCEL_BYTES / 1e6).toFixed(2)}MB) para texto/historial/overhead`
)

// --- Consistencia entre las 3 constantes: el peor caso (todas las
// imágenes al tamaño máximo permitido) debe seguir cabiendo en el
// presupuesto total. Si esto falla, alguien cambió un número sin
// recalcular los otros dos (ver el comentario junto a
// TAMANIO_MAXIMO_BYTES_POR_IMAGEN). ---
const INFLACION_BASE64 = 4 / 3 // base64 siempre pesa 4/3 del binario
const peorCasoBytes = MAXIMO_IMAGENES_POR_MENSAJE * TAMANIO_MAXIMO_BYTES_POR_IMAGEN * INFLACION_BASE64
verificar(
  peorCasoBytes <= PRESUPUESTO_TOTAL_BASE64_BYTES,
  `Peor caso real (${MAXIMO_IMAGENES_POR_MENSAJE} fotos al máximo tamaño, ${(peorCasoBytes / 1e6).toFixed(2)}MB en base64) cabe en el presupuesto (${(PRESUPUESTO_TOTAL_BASE64_BYTES / 1e6).toFixed(2)}MB)`
)

// --- verificarPresupuestoAdjuntos: casos reales ---
function imagenFalsa(bytesBase64: number): ImagenComprimida {
  return { base64: 'a'.repeat(bytesBase64), tipo: 'image/jpeg' }
}

verificar(verificarPresupuestoAdjuntos([]).cabe, 'Sin imágenes, siempre cabe')

const docePeqeñas = Array.from({ length: MAXIMO_IMAGENES_POR_MENSAJE }, () => imagenFalsa(200_000))
verificar(verificarPresupuestoAdjuntos(docePeqeñas).cabe, `${MAXIMO_IMAGENES_POR_MENSAJE} fotos de 200KB base64 cada una (2.4MB total) caben`)

const demasiadoGrandes = Array.from({ length: MAXIMO_IMAGENES_POR_MENSAJE }, () => imagenFalsa(500_000))
const resultadoGrande = verificarPresupuestoAdjuntos(demasiadoGrandes)
verificar(!resultadoGrande.cabe, `${MAXIMO_IMAGENES_POR_MENSAJE} fotos de 500KB base64 cada una (${(resultadoGrande.bytesTotales / 1e6).toFixed(2)}MB) NO caben — se detecta antes de intentar el envío`)

if (fallos > 0) {
  console.error(`\n${fallos} verificación(es) fallida(s).`)
  process.exit(1)
}
console.log('\nTodo correcto. Nota: la compresión real (canvas/Image) requiere un navegador — verificar visualmente en un dispositivo real antes de dar por cerrada la tarea.')
