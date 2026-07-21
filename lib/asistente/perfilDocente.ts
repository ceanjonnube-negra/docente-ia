// lib/asistente/perfilDocente.ts
//
// Compartido por todos los motores conversacionales: obtener el perfil
// del docente autenticado y convertir el ContextoAplicacion activo en
// texto plano para las instrucciones del modelo. Antes vivía duplicado
// dentro de MotorTextoClaude; se extrajo aquí para que MotorOpenAIRealtime
// lo reutilice sin repetir la lógica.

import { supabase } from '@/lib/supabaseClient'
import type { ContextoAplicacion } from './tipos'

// Forma mínima que usa el resto de la aplicación (menú lateral,
// encabezados de documentos, instrucciones del modelo). `select('*')`
// trae más columnas de las que cualquier pantalla necesita — el índice
// de firma cubre esas sin obligar a declarar cada una aquí.
export type PerfilDocente = {
  id: string
  nombre: string | null
  escuela: string | null
  grado: string | null
  grupo: string | null
  municipio: string | null
  estado: string | null
  [clave: string]: unknown
}

// ÚNICA función que lee perfiles_docentes desde el cliente — tanto
// AsistenteService (fuente de verdad reactiva para toda la interfaz,
// ver EstadoAsistente.perfil) como los motores conversacionales
// (contexto de cada turno) pasan por aquí. Nunca la reimplementes con
// una consulta suelta a Supabase — eso es exactamente lo que producía
// copias locales del grado/grupo que se quedaban desactualizadas tras
// un cambio hecho desde el Chat IA (ver "Corregir sincronización del
// perfil docente en la interfaz").
export async function obtenerPerfilYSesion() {
  const { data: { user } } = await supabase.auth.getUser()
  const { data: { session } } = await supabase.auth.getSession()
  const perfil = user
    ? ((await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()).data as PerfilDocente | null)
    : null
  return { user, session, perfil }
}

export function contextoAplicacionATexto(contexto: ContextoAplicacion): string {
  const partes: string[] = [`Pantalla actual: ${contexto.pantalla}`]
  if (contexto.alumnoNombre) partes.push(`Alumno seleccionado: ${contexto.alumnoNombre}`)
  if (contexto.documentoId) partes.push(`Documento en edición: ${contexto.documentoId}`)
  if (contexto.datosAdicionales) {
    Object.entries(contexto.datosAdicionales).forEach(([clave, valor]) => {
      if (valor !== null && valor !== undefined && valor !== '') partes.push(`${clave}: ${valor}`)
    })
  }
  return partes.join('\n')
}

export function construirInstrucciones(perfil: PerfilDocente | null, contexto: ContextoAplicacion): string {
  const perfilTexto = perfil
    ? `Nombre: ${perfil.nombre}\nEscuela: ${perfil.escuela}\nGrado: ${perfil.grado}\nGrupo: ${perfil.grupo}\nMunicipio: ${perfil.municipio}\nEstado: ${perfil.estado}`
    : ''
  return [perfilTexto, contextoAplicacionATexto(contexto)].filter(Boolean).join('\n\n')
}
