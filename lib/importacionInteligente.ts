import type { SupabaseClient } from '@supabase/supabase-js'

export type AlumnoPreview = {
  numero_lista: number | null
  nombre: string
  curp: string | null
  sexo: string | null
  duplicado?: boolean
}

export type Fase = 'analizando' | 'identificando' | 'comparando' | 'preparando'

export const FASES: Fase[] = ['analizando', 'identificando', 'comparando', 'preparando']

export const MENSAJE_FASE: Record<Fase, string> = {
  analizando: 'Analizando archivos...',
  identificando: 'Identificando alumnos...',
  comparando: 'Comparando información...',
  preparando: 'Preparando revisión...',
}

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export function necesitaAtencion(a: AlumnoPreview): boolean {
  return !a.nombre.trim() || !a.curp || !a.sexo || !!a.duplicado
}

function esHeic(archivo: File): boolean {
  return /\.hei[cf]$/i.test(archivo.name) || archivo.type === 'image/heic' || archivo.type === 'image/heif'
}

export async function convertirHeicSiNecesario(
  nuevos: FileList | File[],
  onErrorConversion: (mensaje: string) => void
): Promise<File[]> {
  const listos: File[] = []
  for (const archivo of Array.from(nuevos)) {
    if (!esHeic(archivo)) {
      listos.push(archivo)
      continue
    }
    try {
      const heic2any = (await import('heic2any')).default
      const convertido = await heic2any({ blob: archivo, toType: 'image/jpeg', quality: 0.9 })
      const blob = Array.isArray(convertido) ? convertido[0] : convertido
      listos.push(new File([blob], archivo.name.replace(/\.hei[cf]$/i, '.jpg'), { type: 'image/jpeg' }))
    } catch {
      onErrorConversion(`No se pudo convertir "${archivo.name}" (HEIC).`)
    }
  }
  return listos
}

// Analiza todos los archivos en paralelo, los combina como un solo conjunto
// (evitando duplicados por nombre normalizado) y avanza por fases amigables.
export async function analizarArchivos(
  archivos: File[],
  callbacks: {
    onFase: (fase: Fase) => void
    onProgreso: (completados: number, total: number) => void
  },
  sb: SupabaseClient,
  institucionId: string
): Promise<AlumnoPreview[]> {
  callbacks.onFase('analizando')
  let completados = 0
  callbacks.onProgreso(0, archivos.length)

  const resultadosPorArchivo = await Promise.all(
    archivos.map(async (archivo) => {
      const formData = new FormData()
      formData.append('archivo', archivo)
      const res = await fetch('/api/importar-alumnos', { method: 'POST', body: formData })
      const data = await res.json()
      completados += 1
      callbacks.onProgreso(completados, archivos.length)
      if (!res.ok) throw new Error(data.error || `No se pudo analizar "${archivo.name}".`)
      return (data.alumnos || []) as AlumnoPreview[]
    })
  )

  callbacks.onFase('identificando')
  await esperar(400)

  const normalizar = (s: string) =>
    s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim()

  const combinados: AlumnoPreview[] = []
  for (const detectadosEnArchivo of resultadosPorArchivo) {
    for (const detectado of detectadosEnArchivo) {
      if (!detectado.nombre?.trim()) continue
      const yaCombinado = combinados.some((c) => normalizar(c.nombre) === normalizar(detectado.nombre))
      if (!yaCombinado) combinados.push(detectado)
    }
  }

  callbacks.onFase('comparando')

  // Compara la CURP detectada contra los alumnos ya registrados en esta
  // institución, para no permitir altas duplicadas de un mismo alumno.
  const { data: alumnosExistentes } = await sb
    .from('alumnos')
    .select('curp')
    .eq('institucion_id', institucionId)
    .not('curp', 'is', null)

  const curpsExistentes = new Set(
    (alumnosExistentes || []).map((a: { curp: string }) => a.curp.trim().toUpperCase())
  )

  const combinadosConDuplicados = combinados.map((c) => ({
    ...c,
    duplicado: !!c.curp && curpsExistentes.has(c.curp.trim().toUpperCase()),
  }))

  await esperar(400)
  callbacks.onFase('preparando')
  await esperar(300)

  return combinadosConDuplicados
}

export type GrupoParaImportar = {
  id: string
  institucion_id: string
  docente_id: string
  ciclo_escolar_id: string
}

// Alumno permanente (solo identidad); su relación con el grupo vive
// únicamente en inscripciones (alumno + grupo + ciclo escolar) — Decisión 11.
export async function guardarAlumnosImportados(
  sb: SupabaseClient,
  grupo: GrupoParaImportar,
  alumnosValidos: AlumnoPreview[]
): Promise<{ error: string | null }> {
  const registrosAlumnos = alumnosValidos.map((a) => ({
    institucion_id: grupo.institucion_id,
    nombre: a.nombre.trim(),
    curp: a.curp,
    sexo: a.sexo,
  }))

  const { data: alumnosCreados, error: insertError } = await sb
    .from('alumnos')
    .insert(registrosAlumnos)
    .select('id')

  if (insertError || !alumnosCreados) {
    return { error: 'Ocurrió un error al guardar los alumnos. Intenta de nuevo.' }
  }

  const registrosInscripciones = alumnosCreados.map((nuevo, i) => ({
    alumno_id: nuevo.id,
    grupo_id: grupo.id,
    ciclo_escolar_id: grupo.ciclo_escolar_id,
    docente_id: grupo.docente_id,
    numero_lista: alumnosValidos[i].numero_lista,
    estatus: 'activo',
  }))

  const { error: inscripcionError } = await sb.from('inscripciones').insert(registrosInscripciones)

  if (inscripcionError) {
    return {
      error: `Se guardaron los alumnos, pero no se pudo crear su inscripción al grupo (${inscripcionError.message}). No aparecerán en Lista hasta corregir esto.`,
    }
  }

  return { error: null }
}
