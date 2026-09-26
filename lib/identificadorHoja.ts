// lib/identificadorHoja.ts
//
// Genera el identificador visible de una hoja de seguimiento (ej.
// "SG-4F7K") — server-only (usa el módulo `crypto` de Node), nunca debe
// importarse desde código de cliente.
//
// Función pura: no toca la base de datos ni sabe nada de Supabase. El
// manejo de colisión contra el UNIQUE real de hojas_evaluacion.
// identificador_visible vive en app/api/proyectos-seguimiento/route.ts,
// que es quien intenta el INSERT y reacciona ante el error de la base —
// nunca se "confía" aquí en que el código generado esté libre.

import { randomInt } from 'crypto'

// Sin O/0 ni I/1/L — evita confusión visual al leerlo a simple vista o
// en una foto de la hoja impresa.
const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const LONGITUD_CODIGO = 4
const PREFIJO = 'SG-'

export function generarCodigoHoja(): string {
  let codigo = ''
  for (let i = 0; i < LONGITUD_CODIGO; i++) {
    codigo += ALFABETO[randomInt(0, ALFABETO.length)]
  }
  return `${PREFIJO}${codigo}`
}

// Validación de identidad de hoja (ver auditoría "Los Insectos y su
// Papel en la Naturaleza" — analizar-hoja/route.ts compara el código
// que la IA observa en la fotografía contra este mismo formato, para
// verificar que la foto corresponde a la hoja esperada). Estas dos
// funciones son PURAS (sin `crypto`, sin Node-only) — a diferencia de
// generarCodigoHoja(), sí pueden importarse desde cualquier lado; se
// mantienen en este archivo para que la generación y la validación
// dependan SIEMPRE del mismo alfabeto/formato, nunca de una copia
// separada que pudiera desalinearse.
const REGEX_IDENTIFICADOR_HOJA = new RegExp(`^${PREFIJO}[${ALFABETO}]{${LONGITUD_CODIGO}}$`)

// Único margen que se acepta al comparar un código observado/ingresado
// contra uno real: espacios y mayúsculas/minúsculas — nunca una
// aproximación de contenido.
export function normalizarIdentificadorHoja(valor: string): string {
  return valor.trim().toUpperCase()
}

// true únicamente si, YA normalizado, el valor cumple EXACTAMENTE el
// formato real que produce generarCodigoHoja() — mismo prefijo, mismo
// alfabeto, misma longitud. Nunca fuzzy/aproximado: no evalúa
// "parecido", solo igualdad de forma.
export function esIdentificadorHojaValido(valor: string): boolean {
  return REGEX_IDENTIFICADOR_HOJA.test(valor)
}
