// lib/documentGen/estiloDocumento.ts
//
// Identidad visual compartida de las planeaciones (PDF; después Word):
// paleta, escala tipográfica y espacios. Verde institucional moderado solo
// como acento; todo legible también impreso en blanco y negro (los acentos
// son oscuros y los fondos muy claros).

export type ColorRGB = readonly [number, number, number] // 0–1
const hex = (h: string): ColorRGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]

// Paleta en hexadecimal (Word la usa así; el PDF, en RGB 0–1).
export const HEX = {
  titulo: '111827',
  texto: '1F2937',
  suave: '4B5563',
  tenue: '6B7280',
  borde: 'D1D5DB',
  acento: '166534', // verde institucional (imprime gris oscuro)
  acentoClaro: 'BBF7D0',
  fondoEvaluacion: 'F3F4F6',
  fondoPanel: 'F9FAFB',
} as const

export const COLORES = Object.fromEntries(Object.entries(HEX).map(([k, v]) => [k, hex(`#${v}`)])) as { readonly [K in keyof typeof HEX]: ColorRGB }

// Tamaños en puntos.
export const TIPOGRAFIA = {
  escuela: 12.5,
  datosEscuela: 9,
  titulo: 17,
  datoEtiqueta: 7,
  datoValor: 10,
  seccion: 10.5,
  sesionEtiqueta: 8.5,
  sesionTitulo: 12.5,
  sesionDatos: 9,
  momento: 10.5,
  cuerpo: 10.5,
  evaluacion: 9.5,
  nota: 9,
  encabezadoCompacto: 8.5,
  pie: 8,
  interlineado: 1.42,
} as const

// Espacios (puntos) antes y después de cada tipo de bloque.
export const ESPACIOS = {
  titulo: { antes: 4, despues: 6 },
  panel: { antes: 6, despues: 4 },
  seccion: { antes: 16, despues: 6 },
  sesion: { antes: 18, despues: 6 },
  momento: { antes: 8, despues: 2 },
  parrafo: { antes: 0, despues: 4 },
  item: { antes: 0, despues: 2.5 },
  numerado: { antes: 0, despues: 3.5 },
  evaluacion: { antes: 6, despues: 4 },
  nota: { antes: 6, despues: 4 },
  firma: { antes: 30, despues: 0 },
} as const

// Compactación determinista: si apretar los espacios (y, al final, un poco
// el interlineado) ahorra páginas, se usa el nivel MENOS compacto que logra
// el mínimo; si no ahorra ninguna, el documento queda en el nivel 1. El
// tamaño de letra nunca cambia.
export const NIVELES_COMPACTACION = [
  { espacios: 1, interlineado: 1.42 },
  { espacios: 0.8, interlineado: 1.4 },
  { espacios: 0.65, interlineado: 1.36 },
  { espacios: 0.5, interlineado: 1.32 },
] as const
export type NivelCompactacion = (typeof NIVELES_COMPACTACION)[number]
