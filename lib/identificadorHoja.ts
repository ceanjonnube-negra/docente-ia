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

export function generarCodigoHoja(): string {
  let codigo = ''
  for (let i = 0; i < LONGITUD_CODIGO; i++) {
    codigo += ALFABETO[randomInt(0, ALFABETO.length)]
  }
  return `SG-${codigo}`
}
