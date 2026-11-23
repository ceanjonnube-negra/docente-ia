// lib/asistente/recuperacionArchivo.ts
//
// Formulario POST nativo con la sesión vigente del docente —el mecanismo de
// las vistas previas de planeación— y recuperación del archivo ORIGINAL
// (Word/PDF) con POST /api/archivos/descargar en modo autenticado, que
// verifica en el servidor que el archivo sea del docente. Funciona en
// iPhone, Android y web. Lo usan las tarjetas del Chat (enlace vencido) y
// Historial; nunca regenera el documento ni llama a la IA.

import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabaseClient'

export async function tokenSesionVigente(): Promise<string | null> {
  try {
    const { data: { session } } = await supabase.auth.getSession()
    return session?.access_token ?? null
  } catch {
    return null
  }
}

// action = SOLO la ruta: ni los datos ni la credencial forman parte de la
// URL — van como campos ocultos del cuerpo del POST.
export function enviarFormularioPost(ruta: string, campos: [string, string][], token: string, destino?: string) {
  const formulario = document.createElement('form')
  formulario.method = 'POST'
  formulario.action = ruta
  formulario.style.display = 'none'
  if (destino) formulario.target = destino
  for (const [clave, valor] of [...campos, ['token', token] as [string, string]]) {
    const campo = document.createElement('input')
    campo.type = 'hidden'
    campo.name = clave
    campo.value = valor
    formulario.appendChild(campo)
  }
  document.body.appendChild(formulario)
  formulario.submit()
  formulario.remove()
}

// Solo un PDF se puede ver en línea; Word y los demás formatos solo se
// descargan (el navegador no los muestra).
export type ModoRecuperacion = 'ver' | 'descargar'
export function modosRecuperacion(formato: string): ModoRecuperacion[] {
  return formato === 'pdf' ? ['ver', 'descargar'] : ['descargar']
}

// Acciones del archivo original de un documento de Historial
// (documentos_generados.archivo_formato). Sin formato conocido, ninguna.
export type AccionArchivoOriginal = { modo: ModoRecuperacion; etiqueta: string }
export function accionesArchivoOriginal(formato: string | null | undefined): AccionArchivoOriginal[] {
  if (formato !== 'word' && formato !== 'pdf' && formato !== 'powerpoint' && formato !== 'excel') return []
  return modosRecuperacion(formato).map((modo) => ({
    modo,
    etiqueta: modo === 'ver' ? '👁️ Ver PDF' : formato === 'pdf' ? '⬇️ Descargar PDF' : '⬇️ Descargar original',
  }))
}

// Ambos originales de una planeación aprobada (Hito 1, Parte 3). Su único
// registro en Historial está vinculado al Word; el PDF original vive en
// planeacion_proyectos.evaluacion.documento_pdf, junto al Word. Se ubica
// por el archivo_id del Word con el cliente del docente: RLS solo deja
// ver proyectos de SUS planeaciones. Nunca crea registros ni regenera
// nada, y no es autoridad: al recuperar, el servidor vuelve a verificar
// que el archivo sea del docente (recuperarArchivoPropio).
export type ArchivoOriginalDocumento = { archivoId: string; formato: string }
const UUID_ARCHIVO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function pdfOriginalDePlaneacion(sb: Pick<SupabaseClient, 'from'>, archivoIdWord: string): Promise<ArchivoOriginalDocumento | null> {
  if (!UUID_ARCHIVO.test(archivoIdWord)) return null
  try {
    const { data } = await sb.from('planeacion_proyectos').select('evaluacion').eq('evaluacion->documento_word->>archivo_id', archivoIdWord).limit(1)
    const evaluacion = (data?.[0] as { evaluacion?: { documento_word?: { archivo_id?: unknown }; documento_pdf?: { archivo_id?: unknown } } } | undefined)?.evaluacion
    const pdf = evaluacion?.documento_pdf?.archivo_id
    return evaluacion?.documento_word?.archivo_id === archivoIdWord && typeof pdf === 'string' && UUID_ARCHIVO.test(pdf) && pdf !== archivoIdWord
      ? { archivoId: pdf, formato: 'pdf' }
      : null
  } catch {
    return null
  }
}

// Acciones de los originales de un documento: con un solo archivo, las de
// siempre (accionesArchivoOriginal); con Word y PDF, las del PDF (Ver y
// Descargar) y "Descargar Word".
export type AccionArchivoDocumento = AccionArchivoOriginal & { archivoId: string }
export function accionesArchivosOriginales(archivos: ArchivoOriginalDocumento[]): AccionArchivoDocumento[] {
  const validos = archivos.filter((a, i) => UUID_ARCHIVO.test(a.archivoId) && accionesArchivoOriginal(a.formato).length > 0 && archivos.findIndex((b) => b.archivoId === a.archivoId) === i)
  if (validos.length <= 1) return validos.flatMap((a) => accionesArchivoOriginal(a.formato).map((x) => ({ ...x, archivoId: a.archivoId })))
  const orden = (f: string) => (f === 'pdf' ? 0 : 1)
  return [...validos].sort((a, b) => orden(a.formato) - orden(b.formato)).flatMap((a) =>
    accionesArchivoOriginal(a.formato).map((x) => ({ ...x, archivoId: a.archivoId, etiqueta: a.formato === 'word' ? '⬇️ Descargar Word' : x.etiqueta })))
}

// El archivo se identifica por archivoId (registro en archivos_generados)
// o, en tarjetas antiguas, por su URL firmada persistida.
export type ReferenciaArchivoOriginal = { archivoId?: string | null; url?: string | null }

function enviarRecuperacion(referencia: ReferenciaArchivoOriginal, modo: ModoRecuperacion, token: string, destino?: string) {
  const archivo: [string, string] = referencia.archivoId ? ['archivoId', referencia.archivoId] : ['u', referencia.url ?? '']
  enviarFormularioPost('/api/archivos/descargar', [['modo', modo], archivo], token, destino)
}

export function recuperarArchivo(referencia: ReferenciaArchivoOriginal, modo: ModoRecuperacion, alFallar: () => void) {
  if (!referencia.archivoId && !referencia.url) { alFallar(); return }
  if (modo === 'ver') {
    // La ventana se abre en el mismo toque (Safari en iPhone bloquea
    // window.open después de un await).
    const nombreVentana = `archivo-${Date.now()}`
    const ventana = window.open('', nombreVentana)
    if (!ventana) { alFallar(); return }
    void tokenSesionVigente().then((token) => {
      if (!token) { ventana.close(); alFallar(); return }
      enviarRecuperacion(referencia, modo, token, nombreVentana)
    })
    return
  }
  void tokenSesionVigente().then((token) => {
    if (!token) { alFallar(); return }
    enviarRecuperacion(referencia, modo, token)
  })
}
