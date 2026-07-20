// lib/asistente/hooks.ts
//
// Puente entre AsistenteService (singleton fuera de React) y los
// componentes. useSyncExternalStore es el primitivo correcto para esto —
// ya viene con React, no hace falta ninguna librería de estado global.

'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { AsistenteService } from './AsistenteService'
import type { AdjuntoImagen, ContextoAplicacion, Herramienta } from './tipos'

export function useAsistente() {
  const estado = useSyncExternalStore(
    AsistenteService.suscribir,
    AsistenteService.obtenerSnapshot,
    AsistenteService.obtenerSnapshot
  )

  return {
    ...estado,
    enviarMensaje: (texto: string, adjunto?: AdjuntoImagen) => AsistenteService.enviarMensaje(texto, adjunto),
    abrirPanel: () => AsistenteService.abrirPanel(),
    cerrarPanel: () => AsistenteService.cerrarPanel(),
    togglePanel: () => AsistenteService.togglePanel(),
    interrumpir: () => AsistenteService.interrumpir(),
    activarModoVoz: () => AsistenteService.activarModoVoz(),
    desactivarModoVoz: () => AsistenteService.desactivarModoVoz(),
    cancelarConexionVoz: () => AsistenteService.cancelarConexionVoz(),
    alternarTurnoVoz: () => AsistenteService.alternarTurnoVoz(),
    actualizarMensaje: (id: string, nuevoTexto: string) => AsistenteService.actualizarMensaje(id, nuevoTexto),
    reintentarGeneracion: () => AsistenteService.reintentarGeneracion(),
    nuevaConversacion: () => AsistenteService.nuevaConversacion(),
    abrirConversacion: (id: string) => AsistenteService.abrirConversacion(id),
    eliminarConversacion: (id: string) => AsistenteService.eliminarConversacion(id),
    confirmarAccionCalendario: (mensajeId: string, accionId: string) => AsistenteService.confirmarAccionCalendario(mensajeId, accionId),
  }
}

// Cada pantalla llama esto con su contexto actual (qué alumno, qué
// documento, qué está haciendo el docente). Se actualiza automáticamente
// cuando cambian los valores relevantes, y el asistente lo usa para no
// volver a preguntar algo que ya está frente al usuario.
export function useContextoAsistente(contexto: ContextoAplicacion) {
  const clave = JSON.stringify(contexto)
  useEffect(() => {
    AsistenteService.actualizarContexto(contexto)
    // clave (JSON estable de contexto) es la dependencia real; contexto
    // en sí es un objeto nuevo cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave])
}

// Cada módulo registra las acciones reales que el asistente puede
// ejecutar mientras esa pantalla está montada (ver lib/asistente/tipos.ts
// → Herramienta). Se identifican por nombre, así que registrar de nuevo
// actualiza en vez de duplicar.
export function useHerramientasAsistente(herramientas: Herramienta[]) {
  const clave = herramientas.map(h => h.nombre).join(',')
  useEffect(() => {
    AsistenteService.registrarHerramientas(herramientas)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave])
}
