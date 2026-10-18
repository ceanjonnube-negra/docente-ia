// lib/logSeguro.ts
//
// Privacidad de logs — Etapa B. Representaciones SEGURAS para los logs
// del servidor: nunca nombres de archivo (pueden llevar el nombre de un
// alumno o del docente), ni `message`, `details` o `hint` de un error
// (un 23505 de PostgreSQL trae "Key (nombre, …)=(…)" en details). Solo
// valores tomados de listas cerradas o números validados. Puro, sin I/O
// ni dependencias: seguro para cliente Y servidor (lib/motorContexto.ts
// también corre en el navegador). Nunca lanza: si un valor no puede
// inspeccionarse (getter hostil, Proxy revocado…) devuelve un indicador
// constante. Solo cambia lo que se escribe en el log, nunca el error ni
// el archivo.

const FORMATOS_ARCHIVO = new Set(['docx', 'pdf', 'xlsx', 'pptx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'csv', 'txt'])

export function formatoArchivoSeguro(nombre: unknown): string {
  try {
    if (typeof nombre !== 'string') return 'desconocido'
    const ext = nombre.toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1]
    return ext && FORMATOS_ARCHIVO.has(ext) ? ext : 'otro'
  } catch {
    return 'no_inspeccionable'
  }
}

export function archivoSeguro(nombre: unknown, bytes?: unknown): string {
  try {
    const tamano = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0 ? ` bytes=${bytes}` : ''
    return `formato=${formatoArchivoSeguro(nombre)}${tamano}`
  } catch {
    return 'formato=no_inspeccionable'
  }
}

// Códigos SQLSTATE / PostgREST conocidos → categoría técnica.
const CATEGORIAS_CODIGO: Record<string, string> = {
  '23505': 'violacion_unicidad',
  '23503': 'violacion_llave_foranea',
  '23502': 'valor_nulo',
  '23514': 'violacion_check',
  '22P02': 'formato_invalido',
  '22001': 'valor_demasiado_largo',
  '22007': 'fecha_invalida',
  '22008': 'fecha_fuera_de_rango',
  '42501': 'permiso_denegado',
  '42P01': 'tabla_inexistente',
  '42703': 'columna_inexistente',
  '42883': 'funcion_inexistente',
  '40001': 'conflicto_serializacion',
  '40P01': 'interbloqueo',
  '55P03': 'bloqueo_no_disponible',
  '57014': 'consulta_cancelada',
  'P0001': 'excepcion_rpc',
  'PGRST116': 'sin_filas',
  'PGRST202': 'funcion_no_encontrada',
  'PGRST204': 'columna_no_encontrada',
  'PGRST301': 'jwt_invalido',
}

// Nombres de clase de error conocidos (JS, Anthropic/OpenAI SDK, Supabase).
const TIPOS_ERROR = new Set([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AbortError', 'TimeoutError',
  'APIError', 'APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'AuthenticationError',
  'BadRequestError', 'PermissionDeniedError', 'NotFoundError', 'ConflictError', 'UnprocessableEntityError',
  'RateLimitError', 'InternalServerError', 'StorageError', 'StorageApiError', 'StorageUnknownError',
  'PostgrestError', 'AuthError', 'AuthApiError', 'ErrorHerramientaDocumento',
])

// codigosConocidos: lista cerrada de mensajes-código del propio sistema
// (p. ej. las excepciones de una RPC) que sí pueden registrarse tal cual.
export function errorSeguro(e: unknown, codigosConocidos: readonly string[] = []): string {
  try {
    return describirError(e, codigosConocidos)
  } catch {
    return 'tipo=no_inspeccionable'
  }
}

function describirError(e: unknown, codigosConocidos: readonly string[]): string {
  if (e === null || e === undefined) return `tipo=${e === null ? 'nulo' : 'indefinido'}`
  if (typeof e !== 'object') return `tipo=${typeof e}`
  const o = e as Record<string, unknown>
  const tipo = typeof o.name === 'string' && TIPOS_ERROR.has(o.name) ? o.name : e instanceof Error ? 'Error' : 'objeto'
  const partes = [`tipo=${tipo}`]
  if (o.code !== undefined && o.code !== null) {
    const codigo = typeof o.code === 'string' && Object.prototype.hasOwnProperty.call(CATEGORIAS_CODIGO, o.code) ? o.code : null
    partes.push(codigo ? `codigo=${codigo} categoria=${CATEGORIAS_CODIGO[codigo]}` : 'codigo=otro')
  }
  const status = typeof o.status === 'number' ? o.status : typeof o.statusCode === 'number' ? o.statusCode : typeof o.statusCode === 'string' && /^\d{3}$/.test(o.statusCode) ? Number(o.statusCode) : null
  if (status !== null && Number.isInteger(status) && status >= 100 && status <= 599) partes.push(`status=${status}`)
  if (typeof o.message === 'string' && codigosConocidos.includes(o.message)) partes.push(`codigo_sistema=${o.message}`)
  return partes.join(' ')
}
