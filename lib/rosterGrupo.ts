import type { SupabaseClient } from '@supabase/supabase-js'
import type { AlumnoRosterPropuesta } from './listaOficial/propuestaActualizacionLista'

export type AlumnoConPosicion = {
  id: string
  nombre: string
  curp: string | null
  sexo: string | null
  fecha_nacimiento: string | null
  posicion: number
}

// Fuente única de verdad para el nombre oficial de un alumno en TODA la
// aplicación — Lista, Asistencia, Chat IA, documentos generados (Word,
// PDF, vista previa), cualquier lugar que muestre o redacte el nombre
// de un alumno. La base de datos ya guarda el nombre completo tal como
// está en el acta/CURP oficial (columna alumnos.nombre) — este dato
// NUNCA se divide, invierte, reordena ni reformatea a "Apellido,
// Nombre" ni ninguna otra convención: se usa exactamente como está
// guardado, siempre. Un modelo de lenguaje (la IA del Chat) puede
// redactar texto ALREDEDOR de este nombre, pero jamás debe ser quien
// lo escribe o reconstruye — ver construirTextoListaAlumnos en
// lib/motorContexto.ts, que arma documentos oficiales de lista sin
// pasar el nombre por Claude.
export function nombreOficialAlumno(alumno: { nombre: string }): string {
  return alumno.nombre
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

// Lista activa del grupo con inscripción y estatus, para las propuestas de
// lista oficial (LISTA-P5): exactamente las filas que toma la base en
// snapshot_roster_lista_oficial (inscripciones activas + alumno), leídas
// con la sesión del docente (RLS). Mismo orden por nombre que
// obtenerRosterConPosicion.
export async function obtenerRosterParaPropuesta(
  sb: SupabaseClient,
  grupoId: string
): Promise<{ data: AlumnoRosterPropuesta[]; error: unknown }> {
  const { data, error } = await sb
    .from('inscripciones')
    .select('id, alumno_id, estatus, alumnos(nombre, curp)')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo')

  if (error || !data) {
    return { data: [], error: error ?? new Error('Sin datos') }
  }

  const filas: AlumnoRosterPropuesta[] = []
  for (const f of data) {
    const a = f.alumnos as unknown as { nombre: string; curp: string | null } | null
    // Una inscripción activa sin alumno visible no se puede proponer: se
    // reporta como error para no firmar contra una lista incompleta.
    if (!a) return { data: [], error: new Error('Inscripción sin alumno visible') }
    filas.push({ alumnoId: f.alumno_id as string, inscripcionId: f.id as string, nombre: a.nombre, curp: a.curp, estatus: f.estatus as string })
  }
  filas.sort((x, y) => x.nombre.localeCompare(y.nombre, 'es'))
  return { data: filas, error: null }
}
