// lib/seguimiento/identidadPaginasHoja.ts
//
// Identidad por página de una hoja de evaluación fotografiada (lógica
// pura, sin IA, sin red). Complementa el gate de identidad global de
// analizar-hoja/route.ts: ese gate comprueba UN código observado para
// todo el lote; aquí se comprueba CADA imagen, para que una página de
// otra hoja nunca se combine con las páginas correctas y sus filas se
// asignen a alumnos que no son.
//
// "El modelo observa. El servidor valida.": el modelo solo transcribe
// el código y el "Página n de m" impresos en cada imagen; nunca conoce
// el valor esperado. Fail-closed: ante cualquier duda la captura
// completa se rechaza, nunca se asignan niveles por aproximación.

import { esIdentificadorHojaValido, normalizarIdentificadorHoja } from '../identificadorHoja'
import { calcularCantidadPaginasHoja, calcularRangosPaginasHoja } from '../documentGen/generarHojaSeguimientoPdf'

export type PaginaObservadaHoja = {
  imagen: number
  identificadorVisible: string | null
  paginaImpresa: number | null
  totalPaginasImpreso: number | null
}

// 'identidad_no_valida' — mismo motivo (y mismo mensaje en la interfaz)
// que el gate global. 'hoja_sin_identidad_por_pagina' — hoja impresa
// antes de que todas sus páginas llevaran código: no se puede capturar
// automáticamente y hace falta una hoja nueva identificable.
export type RazonRechazoPaginas = 'identidad_no_valida' | 'hoja_sin_identidad_por_pagina'

export type ResultadoIdentidadPaginas =
  | { ok: true }
  | { ok: false; razon: RazonRechazoPaginas; mensaje: string }

export const MENSAJE_PAGINAS_NO_VALIDAS =
  'Las fotografías no corresponden a las páginas de la hoja de este proyecto. Fotografía cada página de la misma hoja, una sola vez y en orden, e inténtalo de nuevo.'

export const MENSAJE_HOJA_SIN_IDENTIDAD_POR_PAGINA =
  'Esta hoja se imprimió antes de que todas sus páginas llevaran el código de identificación, así que no se puede capturar automáticamente. Necesitas una hoja nueva con el código en cada página.'

function enteroONull(valor: unknown): number | null {
  return typeof valor === 'number' && Number.isInteger(valor) ? valor : null
}

function textoONull(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() ? valor.trim() : null
}

// Forma mínima de cada elemento de "paginas" — null si la estructura no
// es un arreglo de objetos con "imagen" entera.
export function normalizarPaginasObservadas(valor: unknown): PaginaObservadaHoja[] | null {
  if (!Array.isArray(valor)) return null
  const paginas: PaginaObservadaHoja[] = []
  for (const p of valor) {
    if (typeof p !== 'object' || p === null) return null
    const obj = p as Record<string, unknown>
    const imagen = enteroONull(obj.imagen)
    if (imagen === null) return null
    paginas.push({
      imagen,
      identificadorVisible: textoONull(obj.identificadorVisible),
      paginaImpresa: enteroONull(obj.paginaImpresa),
      totalPaginasImpreso: enteroONull(obj.totalPaginasImpreso),
    })
  }
  return paginas
}

function codigoCoincide(observado: string | null, esperado: string): boolean {
  if (observado === null) return false
  const normalizado = normalizarIdentificadorHoja(observado)
  return esIdentificadorHojaValido(normalizado) && normalizado === normalizarIdentificadorHoja(esperado)
}

export function validarIdentidadPaginasHoja(params: {
  identificadorEsperado: string
  cantidadAlumnos: number
  cantidadImagenes: number
  paginasObservadas: unknown
  filas: { posicion: number; imagen?: number }[]
}): ResultadoIdentidadPaginas {
  const rechazo: ResultadoIdentidadPaginas = { ok: false, razon: 'identidad_no_valida', mensaje: MENSAJE_PAGINAS_NO_VALIDAS }
  const k = params.cantidadImagenes
  const paginasEsperadas = calcularCantidadPaginasHoja(params.cantidadAlumnos)
  if (k !== paginasEsperadas) return rechazo

  // Exactamente un elemento por imagen enviada, imágenes 1..k sin
  // repetir ni faltar.
  const paginas = normalizarPaginasObservadas(params.paginasObservadas)
  if (!paginas || paginas.length !== k) return rechazo
  const porImagen = new Map(paginas.map((p) => [p.imagen, p]))
  if (porImagen.size !== k) return rechazo
  for (let i = 1; i <= k; i++) if (!porImagen.has(i)) return rechazo

  // Hoja de una sola página: basta su código (compatible con hojas
  // anteriores, que no imprimen "Página n de m"). Si el número de página
  // sí se ve, tiene que ser 1 de 1.
  if (k === 1) {
    const unica = porImagen.get(1)!
    if (!codigoCoincide(unica.identificadorVisible, params.identificadorEsperado)) return rechazo
    if (unica.paginaImpresa !== null && unica.paginaImpresa !== 1) return rechazo
    if (unica.totalPaginasImpreso !== null && unica.totalPaginasImpreso !== 1) return rechazo
    if (params.filas.some((f) => f.imagen !== undefined && f.imagen !== 1)) return rechazo
    return { ok: true }
  }

  // Hoja antigua multipágina: el código solo se imprimió en la página 1
  // y ninguna página lleva "Página n de m". No se reconstruye ni se
  // aproxima la identidad de las demás páginas.
  const primera = porImagen.get(1)!
  const esHojaAntigua =
    codigoCoincide(primera.identificadorVisible, params.identificadorEsperado) &&
    paginas.every((p) => p.paginaImpresa === null && p.totalPaginasImpreso === null) &&
    paginas.filter((p) => p.imagen > 1).every((p) => p.identificadorVisible === null)
  if (esHojaAntigua) {
    return { ok: false, razon: 'hoja_sin_identidad_por_pagina', mensaje: MENSAJE_HOJA_SIN_IDENTIDAD_POR_PAGINA }
  }

  // Cada imagen: código de esta hoja y la página que le corresponde por
  // orden (la imagen i debe mostrar "Página i de k"). Esto rechaza
  // páginas mezcladas, repetidas, faltantes, en otro orden o ilegibles.
  for (const p of paginas) {
    if (!codigoCoincide(p.identificadorVisible, params.identificadorEsperado)) return rechazo
    if (p.paginaImpresa !== p.imagen || p.totalPaginasImpreso !== paginasEsperadas) return rechazo
  }

  // Cada fila pertenece, sin ambigüedad, a la imagen en la que se leyó:
  // su posición impresa debe caer en el rango de esa página.
  const rangos = calcularRangosPaginasHoja(params.cantidadAlumnos)
  for (const f of params.filas) {
    if (f.imagen === undefined || !Number.isInteger(f.imagen) || f.imagen < 1 || f.imagen > k) return rechazo
    const rango = rangos[f.imagen - 1]
    if (f.posicion < rango.desde || f.posicion > rango.hasta) return rechazo
  }

  return { ok: true }
}
