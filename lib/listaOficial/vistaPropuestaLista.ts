// lib/listaOficial/vistaPropuestaLista.ts
//
// LISTA-P5 (2b) — lo único que el navegador recibe y guarda de una
// propuesta de lista oficial: un token cifrado (ver sobreCifrado.ts, solo
// servidor), su vencimiento y una vista mínima ya redactada por operación.
// Sin identificadores internos de alumno/inscripción, CURP actuales ni
// lecturas de la foto. Módulo puro: lo importan servidor y cliente.

import type { OperacionPropuestaLista, PayloadPropuestaActualizacionLista } from './propuestaActualizacionLista'

export type VistaOperacionPropuestaLista = {
  // Hash del contenido de la operación (no es un dato personal).
  operacionId: string
  etiqueta: string
  aplicable: boolean
  nota?: string
}

export type PropuestaListaParaCliente = {
  token: string
  expiraEn: string
  operaciones: VistaOperacionPropuestaLista[]
}

const conCurp = (curp: string | null | undefined) => (curp && curp.trim() ? curp.trim().toUpperCase() : 'sin CURP')

function etiquetaOperacion(op: OperacionPropuestaLista): string {
  const leido = op.evidencia.nombreLeido || 'Registro sin nombre legible'
  switch (op.tipo) {
    case 'alta':
      return `Dar de alta a ${op.valorPropuesto?.nombre ?? leido} (${conCurp(op.valorPropuesto?.curp)})`
    case 'correccion_curp':
      return `${leido}: registrar CURP ${conCurp(op.valorPropuesto?.curp)}`
    case 'correccion_nombre':
      return `Corregir nombre a ${op.valorPropuesto?.nombre ?? ''}`
    default:
      return leido
  }
}

const NOTA: Record<string, string> = { requiere_revision: 'Requiere revisión', bloqueado: 'No se puede aplicar' }

// Las bajas nunca se muestran: desde el chat no hay solicitudes de baja.
export function construirVistaPropuesta(payload: PayloadPropuestaActualizacionLista): VistaOperacionPropuestaLista[] {
  return payload.operaciones
    .filter((op) => op.tipo !== 'baja')
    .map((op) => op.clasificacion === 'seguro'
      ? { operacionId: op.operacionId, etiqueta: etiquetaOperacion(op), aplicable: true }
      : { operacionId: op.operacionId, etiqueta: etiquetaOperacion(op), aplicable: false, nota: NOTA[op.clasificacion] ?? 'No se puede aplicar' })
}

// Forma mínima válida (el cliente la comprueba antes de mostrarla).
export function esPropuestaListaParaCliente(v: unknown): v is PropuestaListaParaCliente {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.token === 'string' && o.token.length > 0 && typeof o.expiraEn === 'string' && !Number.isNaN(Date.parse(o.expiraEn)) &&
    Array.isArray(o.operaciones) && o.operaciones.every((x) => {
      const op = x as Record<string, unknown>
      return typeof op === 'object' && op !== null && typeof op.operacionId === 'string' && typeof op.etiqueta === 'string' && typeof op.aplicable === 'boolean'
    })
}
