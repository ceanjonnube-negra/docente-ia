// lib/documentGen/registroArchivos.ts
//
// Registro de archivos generados (etapa 3B-2A, tabla archivos_generados).
// Solo servidor: escribe con la llave de servicio, sea cual sea el
// cliente con el que se suba el archivo (el Chat sube con service role,
// la aprobación de planeaciones con el cliente del docente). El cliente
// del navegador no tiene ningún permiso sobre estas tablas.
//
// Ciclo: registrarArchivo ('subiendo', ANTES de subir) → subida y
// verificación → confirmarArchivo ('activo'). Un archivo solo se entrega
// confirmado; si algo falla después de registrar, marcarArchivoFallido
// ('fallido' = nunca entregado). Nada aquí borra archivos ni registros.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { BUCKET_DOCUMENTOS_GENERADOS } from './almacenamiento'

export type ClaseArchivo = 'conservar' | 'efimero'
// Señal estructurada que un llamador puede pasar a ejecutarHerramientaDocumento.
export type RegistroArchivoSolicitado = { clase: ClaseArchivo; conversacionId?: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Clasificación: 'conservar' siempre, salvo que un llamador pase una
// señal ESTRUCTURADA y verificable de que el archivo es temporal y
// exclusivo de una conversación ({ clase: 'efimero', conversacionId }).
// Nunca se deduce del texto del documento. Hoy ningún flujo la envía, así
// que todos los archivos se registran como 'conservar'. Si llega, la base
// además exige que la conversación sea del mismo docente (FK compuesta);
// si no lo es, se registra como 'conservar'.
export function clasificarArchivo(registro?: RegistroArchivoSolicitado): { clase: ClaseArchivo; conversacionId: string | null } {
  if (registro?.clase === 'efimero' && registro.conversacionId && UUID.test(registro.conversacionId)) {
    return { clase: 'efimero', conversacionId: registro.conversacionId.toLowerCase() }
  }
  return { clase: 'conservar', conversacionId: null }
}

let clienteRegistro: SupabaseClient | null = null

function cliente(): SupabaseClient {
  if (!clienteRegistro) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const llave = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !llave) throw new Error('Falta la configuración del servidor para registrar archivos.')
    clienteRegistro = createClient(url, llave, { auth: { persistSession: false, autoRefreshToken: false } })
  }
  return clienteRegistro
}

// Solo para pruebas: sustituye el cliente del registro.
export function configurarClienteRegistroArchivos(sustituto: SupabaseClient | null) {
  clienteRegistro = sustituto
}

type ErrorBD = { code?: string; message?: string } | null

function mensajeDe(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error ? String((error as { message: unknown }).message) : String(error)
}

// Reintentos cortos para fallos transitorios de la base (nunca regeneran
// el archivo ni llaman a la IA).
async function conReintentos<T>(fn: () => Promise<T>, intentos = 3, esperaMs = 200): Promise<T> {
  let ultimo: unknown
  for (let i = 0; i < intentos; i++) {
    try {
      return await fn()
    } catch (e) {
      ultimo = e
      if (i < intentos - 1) await new Promise((r) => setTimeout(r, esperaMs * (i + 1)))
    }
  }
  throw ultimo
}

export async function registrarArchivo(datos: {
  docenteId: string
  ruta: string
  nombre: string
  tipoMime: string
  tamanoBytes: number
  clase: ClaseArchivo
  conversacionId: string | null
}): Promise<{ id: string; clase: ClaseArchivo }> {
  // Id generado aquí: si una respuesta se pierde y se reintenta, el
  // mismo id choca (23505) y se reconoce el registro ya hecho.
  const id = crypto.randomUUID()
  let { clase, conversacionId } = datos
  return conReintentos(async () => {
    const fila = {
      id,
      docente_id: datos.docenteId,
      bucket: BUCKET_DOCUMENTOS_GENERADOS,
      ruta: datos.ruta,
      nombre: datos.nombre,
      tipo_mime: datos.tipoMime,
      tamano_bytes: datos.tamanoBytes,
      clase,
      conversacion_id: conversacionId,
    }
    const { error } = (await cliente().from('archivos_generados').insert(fila)) as { error: ErrorBD }
    if (!error) return { id, clase }
    if (error.code === '23505') {
      const { data } = await cliente().from('archivos_generados').select('id, clase').eq('id', id).maybeSingle()
      if (data) return { id, clase: data.clase as ClaseArchivo }
    }
    if (error.code === '23503' && clase === 'efimero') {
      // La conversación no es de este docente (o no existe): se conserva.
      console.error('[REGISTRO_ARCHIVOS] conversación no válida — se registra como conservar')
      clase = 'conservar'
      conversacionId = null
    }
    throw error
  })
}

export async function confirmarArchivo(id: string): Promise<void> {
  await conReintentos(async () => {
    const { data, error } = (await cliente()
      .from('archivos_generados')
      .update({ estado: 'activo', activado_en: new Date().toISOString() })
      .eq('id', id)
      .eq('estado', 'subiendo')
      .select('id')) as { data: { id: string }[] | null; error: ErrorBD }
    if (error) throw error
    if (data && data.length > 0) return
    // 0 filas: quizá una confirmación anterior sí llegó (respuesta perdida).
    const { data: actual, error: errorLectura } = (await cliente().from('archivos_generados').select('estado').eq('id', id).maybeSingle()) as { data: { estado: string } | null; error: ErrorBD }
    if (errorLectura) throw errorLectura
    if (actual?.estado === 'activo') return
    throw new Error(`El registro del archivo no se pudo confirmar (estado=${actual?.estado ?? 'inexistente'}).`)
  })
}

// Mejor esfuerzo: nunca lanza (el error original es el que importa).
export async function marcarArchivoFallido(id: string, causa: unknown): Promise<void> {
  try {
    await conReintentos(async () => {
      const { error } = (await cliente()
        .from('archivos_generados')
        .update({ estado: 'fallido', ultimo_error: mensajeDe(causa).slice(0, 500) })
        .eq('id', id)
        .eq('estado', 'subiendo')) as { error: ErrorBD }
      if (error) throw error
    }, 2)
  } catch (e) {
    console.error('[REGISTRO_ARCHIVOS] no se pudo marcar como fallido (queda en subiendo):', mensajeDe(e))
  }
}
