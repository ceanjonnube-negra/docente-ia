// lib/listaOficial/rosterFingerprint.ts
//
// V1-D1 — huella determinista del roster ACTIVO de un grupo en el
// instante en que se construye un PlanDeActualizacionLista (ver
// lib/listaOficial/planActualizacionLista.ts). Objetivo único: que una
// fase posterior de aplicación pueda detectar "este plan se generó
// contra un roster que ya cambió" sin necesitar versión numérica por
// fila ni infraestructura nueva — ver diseño aprobado "V1-D — sección
// J, concurrencia/frescura/HMAC".
//
// Server-only por el mismo motivo que lib/listaOficial/
// propuestaFirmada.ts: usa node:crypto. NUNCA debe importarse desde
// código que corre en el navegador.
//
// Determinismo garantizado por construcción:
//   - la entrada se reduce a EXACTAMENTE 3 campos por fila
//     (inscripcionId, estatus, curp normalizada) — nunca nombre
//     (puede corregirse sin que el roster "cambie" para efectos de
//     este fingerprint, ver snapshot vs. dato vivo en la auditoría
//     V1-D sección F) ni ningún otro campo;
//   - CURP se normaliza (trim + mayúsculas) con la MISMA regla ya
//     usada en matchingListaOficial.ts (curpNormalizada) — nunca una
//     segunda normalización que pudiera divergir;
//   - el orden de entrada nunca importa: se ordena siempre por
//     inscripcionId (UUID, estable, nunca ambiguo — a diferencia de
//     nombre, que puede repetirse) antes de serializar;
//   - JSON.stringify sobre un array de objetos con claves en el MISMO
//     orden literal en cada entrada (nunca Object.keys dependiente del
//     orden de inserción de un objeto externo) produce una cadena
//     estable para la misma entrada lógica.
//
// Pura: 0 Supabase, 0 IA, 0 red — solo recibe filas ya leídas por el
// llamador (mismo roster que ya usa obtenerRosterConPosicion).

import { createHash } from 'node:crypto'

export type FilaRosterParaFingerprint = {
  inscripcionId: string
  estatus: string
  curp: string | null
}

function curpNormalizadaOrNull(curp: string | null): string | null {
  const limpia = curp?.trim()
  return limpia ? limpia.toUpperCase() : null
}

// Exportada para que las pruebas deterministas puedan verificar la
// forma canónica exacta sin depender de conocer el hash SHA-256 de
// memoria — nunca usada por ningún llamador de producción, que debe
// usar calcularRosterFingerprint.
export function construirRepresentacionCanonicaRoster(filas: FilaRosterParaFingerprint[]): { inscripcionId: string; estatus: string; curpNormalizada: string | null }[] {
  return filas
    .map((f) => ({ inscripcionId: f.inscripcionId, estatus: f.estatus, curpNormalizada: curpNormalizadaOrNull(f.curp) }))
    .sort((a, b) => a.inscripcionId.localeCompare(b.inscripcionId))
}

export function calcularRosterFingerprint(filas: FilaRosterParaFingerprint[]): string {
  const canonico = construirRepresentacionCanonicaRoster(filas)
  return createHash('sha256').update(JSON.stringify(canonico)).digest('hex')
}
