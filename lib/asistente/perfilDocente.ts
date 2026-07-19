// lib/asistente/perfilDocente.ts
//
// Compartido por todos los motores conversacionales: obtener el perfil
// del docente autenticado y convertir el ContextoAplicacion activo en
// texto plano para las instrucciones del modelo. Antes vivía duplicado
// dentro de MotorTextoClaude; se extrajo aquí para que MotorOpenAIRealtime
// lo reutilice sin repetir la lógica.

import { supabase } from '@/lib/supabaseClient'
import type { ContextoAplicacion } from './tipos'

export async function obtenerPerfilYSesion() {
  const { data: { user } } = await supabase.auth.getUser()
  const { data: { session } } = await supabase.auth.getSession()
  const perfil = user
    ? (await supabase.from('perfiles_docentes').select('*').eq('id', user.id).single()).data
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function construirInstrucciones(perfil: any, contexto: ContextoAplicacion): string {
  const perfilTexto = perfil
    ? `Nombre: ${perfil.nombre}\nEscuela: ${perfil.escuela}\nGrado: ${perfil.grado}\nGrupo: ${perfil.grupo}\nMunicipio: ${perfil.municipio}\nEstado: ${perfil.estado}`
    : ''
  return [perfilTexto, contextoAplicacionATexto(contexto)].filter(Boolean).join('\n\n')
}
