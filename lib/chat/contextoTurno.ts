// lib/chat/contextoTurno.ts
//
// Contexto del turno duradero que /api/chat está ejecutando (solo
// servidor). Lo que deba quedar ligado ATÓMICAMENTE al resultado del turno
// se difiere aquí y lo escribe completar_turno_chat en la misma transacción
// que el turno (y, con protocolo >= 1, que el mensaje del asistente). Hoy:
// los metadatos del borrador de ajuste (registrarAjuste), sin los cuales no
// se puede aprobar. Fuera de un turno (imágenes, archivos, voz, o sin la
// infraestructura de turnos) todo se escribe como siempre.

import { AsyncLocalStorage } from 'node:async_hooks'

export type AjusteDelTurno = { planeacionId: string; versionBase: number; grupoId: string; huella: string; formatoSolicitado?: 'word' | 'pdf' | null }
export type ContextoTurno = { conversacionId: string; ajuste: AjusteDelTurno | null }

const almacen = new AsyncLocalStorage<ContextoTurno>()

export function ejecutarEnTurno<T>(contexto: ContextoTurno, fn: () => T): T {
  return almacen.run(contexto, fn)
}

// true: el ajuste queda para completar_turno_chat (misma conversación del
// turno); false: no hay turno y el llamador lo escribe como siempre.
export function diferirAjusteAlTurno(conversacionId: string | null, ajuste: AjusteDelTurno): boolean {
  const contexto = almacen.getStore()
  if (!contexto || !conversacionId || contexto.conversacionId !== conversacionId) return false
  contexto.ajuste = ajuste
  return true
}
