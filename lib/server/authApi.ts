// lib/server/authApi.ts
//
// SERVER-ONLY — nunca importar desde un componente 'use client' ni desde
// código que se ejecute en el navegador (no exporta nada del cliente de
// Supabase con anon key sin token, solo helpers que validan un token ya
// recibido). Ver "Fase 1A — Protección de endpoints críticos": reúne el
// patrón de validación explícita que ya usaba app/api/realtime-token/
// route.ts (la única ruta del proyecto que ya llamaba
// supabase.auth.getUser() para rechazar un token inválido/expirado con
// 401, en vez de solo comprobar que no viniera vacío como hacen los
// demás endpoints existentes) para reutilizarlo en los endpoints que se
// cierran en esta fase — sin migrar el resto de rutas ya existentes.

import { createClient, type SupabaseClient, type User } from '@supabase/supabase-js'

export type ResultadoAuth =
  | { ok: true; user: User; supabase: SupabaseClient }
  | { ok: false; status: 401; mensaje: string }

// Valida el access token contra Supabase — nunca confía solo en que "no
// venga vacío". Si es válido, regresa un cliente YA autenticado con ese
// token (para que auth.uid() resuelva correctamente dentro de cualquier
// política RLS que una consulta posterior dispare).
export async function autenticarRequestApi(accessToken: string | null | undefined): Promise<ResultadoAuth> {
  if (!accessToken) {
    return { ok: false, status: 401, mensaje: 'Sesión no encontrada.' }
  }
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    { global: { headers: { Authorization: `Bearer ${accessToken}` } } }
  )
  const { data: { user }, error } = await supabase.auth.getUser(accessToken)
  if (error || !user) {
    return { ok: false, status: 401, mensaje: 'Sesión inválida o expirada.' }
  }
  return { ok: true, user, supabase }
}

// Lee "Authorization: Bearer <token>" de la request — convención para
// los endpoints nuevos de esta fase (los 5 endpoints de referencia
// existentes mandan accessToken en el body en vez de header; se
// mantiene esa convención existente sin tocarla, ver diagnóstico
// entregado antes de implementar).
export function extraerBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') || req.headers.get('Authorization')
  if (!header) return null
  const match = header.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

// Para las rutas que el navegador abre por NAVEGACIÓN (un <form> POST —
// pestaña nueva o descarga), donde no se puede mandar el header
// Authorization: el token de la sesión vigente viaja como campo del
// CUERPO, nunca en la URL (historial, logs de acceso, enlaces
// compartidos). Solo campos de texto; null si el cuerpo no es un
// formulario válido.
export async function leerFormularioPost(req: Request): Promise<URLSearchParams | null> {
  try {
    const formulario = await req.formData()
    const parametros = new URLSearchParams()
    for (const [clave, valor] of formulario.entries()) if (typeof valor === 'string') parametros.append(clave, valor)
    return parametros
  } catch {
    return null
  }
}

// Error legible para una respuesta a la que el navegador NAVEGA (pestaña
// de "Ver" o descarga): una página mínima con el mensaje — nunca JSON
// crudo ni un archivo vacío. El mensaje es siempre un texto fijo del
// propio código; se escapa igual, y nunca repite parámetros ni
// credenciales de la petición.
export function respuestaErrorNavegacion(mensaje: string, status: number, headers: Record<string, string> = {}): Response {
  const seguro = mensaje.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return new Response(
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Docente IA</title></head><body style="font-family:system-ui,sans-serif;padding:24px;color:#374151"><p>${seguro}</p></body></html>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } }
  )
}

// Mismo patrón real que ya usa app/dashboard/grupos/nuevo/page.tsx
// (líneas 105-120) para resolver las instituciones de un docente: la
// principal en perfiles_docentes.institucion_id, más las adicionales en
// docente_instituciones. Reutilizado aquí del lado servidor, no
// reinventado — requiere el cliente YA autenticado que devuelve
// autenticarRequestApi(), nunca el cliente anon sin token.
export async function usuarioPerteneceAInstitucion(
  supabase: SupabaseClient,
  userId: string,
  institucionId: string
): Promise<boolean> {
  const { data: perfil } = await supabase
    .from('perfiles_docentes')
    .select('institucion_id')
    .eq('id', userId)
    .maybeSingle()

  if (perfil?.institucion_id === institucionId) return true

  const { data: extra } = await supabase
    .from('docente_instituciones')
    .select('institucion_id')
    .eq('docente_id', userId)
    .eq('institucion_id', institucionId)
    .maybeSingle()

  return Boolean(extra)
}
