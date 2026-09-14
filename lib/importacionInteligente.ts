import type { SupabaseClient } from '@supabase/supabase-js'
import type { ResultadoComparacionListaOficial } from './listaOficial/matchingListaOficial'

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

  // FASE 1A — "Protección de endpoints críticos": /api/importar-alumnos
  // ahora exige sesión válida. Un solo access_token para todas las
  // llamadas en paralelo de abajo (misma sesión, no cambia entre
  // archivos de un mismo análisis).
  const { data: { session } } = await sb.auth.getSession()
  if (!session?.access_token) {
    throw new Error('No se encontró una sesión activa. Inicia sesión de nuevo.')
  }

  const resultadosPorArchivo = await Promise.all(
    archivos.map(async (archivo) => {
      const formData = new FormData()
      formData.append('archivo', archivo)
      const res = await fetch('/api/importar-alumnos', {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      })
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
//
// La escritura real ocurre por completo dentro de la RPC
// importar_alumnos_a_grupo (SECURITY DEFINER, atómica): docente_id/
// institucion_id/ciclo_escolar_id se derivan ahí del grupo ya validado
// contra auth.uid(), nunca se envían desde aquí como autoritativos —
// grupo.id es solo el recurso solicitado, no una autorización. Único
// camino de alta soportado: no existe ningún INSERT directo restante
// sobre alumnos/inscripciones en este archivo.
// Rama de COMPARACIÓN/ACTUALIZACIÓN (fase 1, read-only) — solo aplica
// cuando el grupo ya tiene roster y el lote seleccionado son imágenes
// (V1-A hoy solo lee imágenes; máximo 4 por análisis, mismo límite que
// ya impone analizarImagenesListaOficial). Cualquier archivo o cantidad
// que no cumpla esto queda deliberadamente fuera de esta rama — el
// caller debe entonces usar el flujo de ALTA existente sin cambios, en
// vez de intentar una extracción nueva no auditada.
const EXTENSIONES_IMAGEN_COMPARABLE = ['jpg', 'jpeg', 'png', 'gif', 'webp']
const MAX_IMAGENES_COMPARACION = 4

// Fuente de verdad REAL para decidir ALTA vs COMPARACIÓN — nunca un
// prop calculado en un render anterior (puede quedar desactualizado si
// el roster cambia en otra pestaña/dispositivo o vía Chat IA mientras
// Lista permanece abierta). Lectura fresca, mínima y read-only: solo
// existencia (LIMIT 1), nunca el roster completo — misma tabla/filtro
// que ya usa obtenerRosterConPosicion (grupo_id + estatus='activo'),
// mismo cliente autenticado del navegador, mismas policies RLS ya
// probadas — no introduce una segunda definición de "qué es el
// roster". Propaga cualquier error del lado del caller: quien llama
// decide fail-closed, esta función nunca aproxima "vacío" ante un
// fallo.
export async function tieneRosterActivo(sb: SupabaseClient, grupoId: string): Promise<boolean> {
  const { data, error } = await sb
    .from('inscripciones')
    .select('id')
    .eq('grupo_id', grupoId)
    .eq('estatus', 'activo')
    .limit(1)

  if (error) {
    throw new Error('No se pudo verificar el estado actual del grupo.')
  }
  return (data?.length ?? 0) > 0
}

export function esLoteComparableConRoster(archivos: File[]): boolean {
  return (
    archivos.length > 0 &&
    archivos.length <= MAX_IMAGENES_COMPARACION &&
    archivos.every((a) => EXTENSIONES_IMAGEN_COMPARABLE.includes((a.name.split('.').pop() || '').toLowerCase()))
  )
}

// Llama al endpoint READ-ONLY /api/importar-alumnos/comparar — nunca
// escribe nada. La comparación en sí (V1-B, compararListaOficial) y la
// extracción (V1-A) ocurren del lado servidor, sin cambios respecto a
// esos módulos; esta función solo empaqueta la llamada HTTP, mismo
// patrón de sesión ya usado por analizarArchivos.
export async function compararConRosterActual(
  archivos: File[],
  sb: SupabaseClient,
  grupoId: string
): Promise<ResultadoComparacionListaOficial> {
  const { data: { session } } = await sb.auth.getSession()
  if (!session?.access_token) {
    throw new Error('No se encontró una sesión activa. Inicia sesión de nuevo.')
  }

  const formData = new FormData()
  formData.append('grupo_id', grupoId)
  for (const archivo of archivos) {
    formData.append('archivos', archivo)
  }

  const res = await fetch('/api/importar-alumnos/comparar', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.access_token}` },
    body: formData,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || 'No se pudo comparar la lista con el grupo actual.')
  return data.comparacion as ResultadoComparacionListaOficial
}

export async function guardarAlumnosImportados(
  sb: SupabaseClient,
  grupo: GrupoParaImportar,
  alumnosValidos: AlumnoPreview[]
): Promise<{ error: string | null }> {
  const payload = alumnosValidos.map((a) => ({
    nombre: a.nombre.trim(),
    curp: a.curp,
    sexo: a.sexo,
  }))

  const { error } = await sb.rpc('importar_alumnos_a_grupo', {
    p_grupo_id: grupo.id,
    p_alumnos: payload,
  })

  if (error) {
    return { error: 'Ocurrió un error al guardar los alumnos. Intenta de nuevo.' }
  }

  return { error: null }
}
