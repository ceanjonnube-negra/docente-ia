import type { SupabaseClient } from '@supabase/supabase-js'

export type AlumnoConPosicion = {
  id: string
  nombre: string
  curp: string | null
  sexo: string | null
  fecha_nacimiento: string | null
  posicion: number
}

// Única fuente de verdad para el número de lista: se calcula aquí, a partir
// de la inscripción activa de cada alumno en el grupo, y nunca se guarda en
// la base de datos. Lista y Ficha Inteligente llaman esta misma función para
// garantizar que siempre muestren el mismo número.
export async function obtenerRosterConPosicion(
  sb: SupabaseClient,
  grupoId: string
): Promise<{ data: AlumnoConPosicion[]; error: unknown }> {
  const { data, error } = await sb
    .from('inscripciones')
    .select('alumnos(id, nombre, curp, sexo, fecha_nacimiento)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo')

  if (error || !data) {
    return { data: [], error: error ?? new Error('Sin datos') }
  }

  const roster = data
    .map(i => i.alumnos as unknown as Omit<AlumnoConPosicion, 'posicion'> | null)
    .filter((a): a is Omit<AlumnoConPosicion, 'posicion'> => a !== null)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'))
    .map((a, index) => ({ ...a, posicion: index + 1 }))

  return { data: roster, error: null }
}
