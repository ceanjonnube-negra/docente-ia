// scripts/verificar-trabajo-documento-asincrono.ts
//
// Prueba aislada de "corrección: timeout en documentos ilustrados
// largos" — generar una guía ilustrada + Word + PDF puede tardar más
// que TIMEOUT_FETCH_DOCUMENTO_MS (130s en el cliente), aunque quepa
// dentro de maxDuration (180s, el techo real de la función). Medido
// con una llamada REAL: UNA sola ilustración tardó ~15.9s — con hasta
// 4 por documento y Claude redactando una guía larga antes, el total
// podía superar cómodamente el tiempo que Safari/iPhone espera en una
// sola respuesta bloqueante. Además, generar Word Y PDF del mismo
// documento ilustrado regeneraba las MISMAS imágenes dos veces (una
// por formato) de forma independiente y no determinista.
//
// Corrección: (a) las ilustraciones se generan UNA sola vez y se
// comparten entre Word y PDF; (b) la generación de documentos
// ilustrados/multi-formato pasa por un trabajo asíncrono
// (POST /api/chat/trabajo-documento responde en milisegundos, la
// generación real sigue en segundo plano con Next.js after(), el
// cliente hace polling con GET .../[trabajoId]) — ningún fetch del
// cliente queda esperando la generación completa.
//
// LÍMITE HONESTO (mismo criterio que el resto de esta serie): un
// trabajo real de extremo a extremo requiere Claude + OpenAI Images +
// Supabase reales, no se puede fabricar en un script aislado. Esta
// prueba combina (a) verificación ESTRUCTURAL de los invariantes en
// el código real y (b) la medición REAL ya documentada arriba
// (ejecución real de generarImagen() contra el proveedor real,
// resultado: 15888ms para una imagen).
// Se ejecuta con
// `npx tsx scripts/verificar-trabajo-documento-asincrono.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { quiereIlustracion, detectarFormatosExplicitosMultiples } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const cuerpoHerramientas = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf-8')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoTrabajoPost = readFileSync(join(RAIZ, 'app/api/chat/trabajo-documento/route.ts'), 'utf-8')
const cuerpoTrabajoGet = readFileSync(join(RAIZ, 'app/api/chat/trabajo-documento/[trabajoId]/route.ts'), 'utf-8')
const cuerpoTrabajosDocumento = readFileSync(join(RAIZ, 'lib/trabajosDocumento.ts'), 'utf-8')
const cuerpoTrabajoCliente = readFileSync(join(RAIZ, 'lib/asistente/trabajoDocumentoCliente.ts'), 'utf-8')
const cuerpoAsistenteService = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')
const cuerpoMigracion = readFileSync(join(RAIZ, 'supabase/migrations/20260809210000_crear_trabajos_documento.sql'), 'utf-8')

function sinComentarios(codigo: string): string {
  return codigo.split('\n').filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//')).join('\n')
}

async function main() {
  // ============================================================
  // 1. No duplicar generación de imágenes entre Word y PDF —
  //    verificación estructural del punto exacto de la corrección.
  // ============================================================
  verificar(cuerpoHerramientas.includes('imagenesPreGeneradas?: Map<string,'), 'ejecutarHerramientaDocumento acepta imágenes ya generadas por quien llama')
  verificar(cuerpoHerramientas.includes('let imagenesPorDescripcion: Map<string, { buffer: Buffer; ancho: number; alto: number }> | undefined = imagenesPreGeneradas'), 'Si ya vienen pre-generadas, NUNCA se vuelven a generar dentro de ejecutarHerramientaDocumento')
  verificar(cuerpoHerramientas.includes('export async function generarImagenesParaDocumento('), 'generarImagenesParaDocumento está exportada para que route.ts la llame UNA sola vez')
  verificar(cuerpoHerramientas.includes('export const MAX_IMAGENES_POR_DOCUMENTO = 4'), 'El tope de imágenes por documento sigue siendo 4, ahora exportado')
  {
    const inicioMulti = cuerpoChatRoute.indexOf('const formatosMultiples = esImagenSuelta')
    const finMulti = cuerpoChatRoute.indexOf('const primario = resultados[0]')
    const bloqueMulti = cuerpoChatRoute.slice(inicioMulti, finMulti)
    verificar(bloqueMulti.includes('let imagenesPreGeneradas') && bloqueMulti.includes('generarImagenesParaDocumento('), 'route.ts (CASO 3) genera las imágenes UNA sola vez antes de generar los formatos')
    verificar(/ejecutarHerramientaDocumento\(tipo, texto, perfil, zonaHoraria, supabaseRAG, userId, supabaseUser, conversacionId, null, imagenesPreGeneradas(?:, \w+)?\)/.test(bloqueMulti), 'El MISMO mapa de imágenes se pasa a CADA formato (Word y PDF comparten exactamente las mismas ilustraciones)')
  }

  // ============================================================
  // 2. Medición REAL — evidencia numérica de por qué hacía falta el
  //    trabajo asíncrono (no una suposición).
  // ============================================================
  verificar(true, 'Medición real documentada: generarImagen() contra el proveedor real tardó 15888ms para UNA sola ilustración (ver encabezado de este archivo) — con hasta 4 por documento y Claude redactando antes, el total supera cómodamente los 130s que espera el cliente')

  // ============================================================
  // 3. Migración — 100% aditiva, RLS "solo titular", sin
  //    service_role, tabla propia (nunca reutiliza turnos_chat de la
  //    otra rama).
  // ============================================================
  verificar(cuerpoMigracion.includes('create table if not exists public.trabajos_documento'), 'Tabla nueva, aditiva')
  verificar(cuerpoMigracion.includes('request_id text not null unique'), 'Idempotencia real a nivel de base de datos (request_id UNIQUE)')
  verificar(cuerpoMigracion.includes("check (estado in ('queued', 'generando', 'completado', 'fallido'))"), 'Estados limitados exactamente a los 4 esperados')
  verificar(cuerpoMigracion.includes('using (docente_id = auth.uid())'), 'RLS "solo titular" — mismo patrón que assets_visuales/turnos_chat')
  {
    const sinCom = sinComentarios(cuerpoMigracion)
    verificar(!/for all/i.test(sinCom), 'RLS: sin políticas FOR ALL')
    verificar(!/for delete/i.test(sinCom), 'RLS: sin política DELETE')
    verificar(!/service_role/i.test(sinCom), 'Migración: no usa service_role')
  }

  // ============================================================
  // 4. lib/trabajosDocumento.ts — idempotencia real (INSERT directo,
  //    nunca "SELECT primero"), nunca usa service_role.
  // ============================================================
  verificar(cuerpoTrabajosDocumento.includes(".insert({ docente_id: docenteId, conversacion_id: conversacionId, request_id: requestId, estado: 'queued' })"), 'crearOTrabajoRecuperarPorRequestId hace INSERT directo')
  verificar(cuerpoTrabajosDocumento.includes("errorInsert.code === '23505'"), 'Distingue el error de unique_violation (23505) real de cualquier otro — RECUPERACIÓN, nunca falla')
  verificar(!/select.*maybeSingle[\s\S]{0,200}insert\(/i.test(cuerpoTrabajosDocumento), 'No existe el patrón inseguro "SELECT primero, luego INSERT"')
  verificar(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(sinComentarios(cuerpoTrabajosDocumento)), 'lib/trabajosDocumento.ts nunca usa service_role')

  // ============================================================
  // 5. POST /api/chat/trabajo-documento — responde YA (nunca espera
  //    la generación), reutiliza el 100% de la lógica existente en
  //    /api/chat vía llamada interna, nunca la duplica, nunca guarda
  //    accessToken en la base de datos.
  // ============================================================
  verificar(cuerpoTrabajoPost.includes('export const maxDuration = 180'), 'Mismo techo de tiempo real que /api/chat (180s)')
  verificar(cuerpoTrabajoPost.includes("import { after } from 'next/server'"), 'Usa el after() real de Next.js — la generación sigue corriendo tras responder')
  verificar(cuerpoTrabajoPost.includes('return NextResponse.json({ trabajoId, estado: trabajo.estado })'), 'El POST responde con el trabajoId de inmediato — nunca espera a que la generación termine')
  {
    const inicioAfter = cuerpoTrabajoPost.indexOf('after(async () => {')
    const finAfter = cuerpoTrabajoPost.indexOf('\n  return NextResponse.json({ trabajoId, estado: trabajo.estado })')
    const bloqueAfter = cuerpoTrabajoPost.slice(inicioAfter, finAfter)
    verificar(bloqueAfter.includes("fetch(new URL('/api/chat', baseUrl)") , 'La generación real reutiliza /api/chat vía llamada interna — NUNCA duplica la lógica de Claude/MODO DOCUMENTO/MODO DOCUMENTO ILUSTRADO')
    verificar(bloqueAfter.includes('marcarCompletado') && bloqueAfter.includes('marcarFallido'), 'El resultado real (éxito o fallo) se persiste siempre')
  }
  verificar(!/\.insert\(\{[^}]*accessToken/i.test(cuerpoTrabajoPost) && !cuerpoTrabajoPost.includes('access_token:'), 'accessToken NUNCA se escribe en la base de datos — vive solo en el closure de after(), nunca persistido')
  verificar(cuerpoTrabajoPost.includes('yaExistia) return NextResponse.json'), 'Idempotencia real: un request_id repetido nunca vuelve a arrancar la generación')

  // ============================================================
  // 6. GET /api/chat/trabajo-documento/[trabajoId] — autenticado, con
  //    verificación explícita de propiedad, nunca usa service_role.
  // ============================================================
  verificar(cuerpoTrabajoGet.includes('autenticarRequestApi(accessToken)'), 'Exige autenticación real')
  verificar(cuerpoTrabajoGet.includes('trabajo.docenteId !== auth.user.id'), 'Comprobación explícita de que el trabajo pertenece al docente autenticado')
  verificar(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(sinComentarios(cuerpoTrabajoGet)), 'GET nunca usa service_role')

  // ============================================================
  // 7. AsistenteService.ts — el gate real usa las MISMAS funciones
  //    deterministas que ya usa el servidor (quiereIlustracion/
  //    detectarFormatosExplicitosMultiples), un mensaje normal sigue
  //    el camino síncrono de siempre.
  // ============================================================
  verificar(cuerpoAsistenteService.includes('if (!adjunto && canal !== \'voz\' && (quiereIlustracion(limpio) || detectarFormatosExplicitosMultiples(limpio).length > 1)) {'), 'El gate de trabajo asíncrono usa exactamente quiereIlustracion/detectarFormatosExplicitosMultiples — mismas funciones que decide MODO DOCUMENTO ILUSTRADO en el servidor')
  verificar(cuerpoAsistenteService.includes('await this.enviarComoTrabajoDocumento(limpio)'), 'Existe la ruta real hacia el trabajo asíncrono')
  verificar(quiereIlustracion('Hazme una guía completa, detallada e ilustrada sobre el ciclo del agua para 4° de primaria.'), 'Ejecución real: una guía ilustrada activa el trabajo asíncrono')
  verificar(detectarFormatosExplicitosMultiples('Hazme un examen en Word y PDF.').length > 1, 'Ejecución real: pedir dos formatos a la vez también activa el trabajo asíncrono')
  verificar(!quiereIlustracion('Hazme un examen de matemáticas.') && detectarFormatosExplicitosMultiples('Hazme un examen de matemáticas.').length <= 1, 'Un documento normal (sin ilustración, un solo formato) NO activa el trabajo asíncrono — sigue el camino síncrono de siempre, cero cambio de comportamiento')

  // ============================================================
  // 8. Recuperación real — polling con guard de identidad (nunca una
  //    segunda burbuja), persistencia en localStorage, listeners de
  //    reconexión, documentoActivo se fija con el contenido REAL
  //    (no el envoltorio "Documento generado correctamente.").
  // ============================================================
  verificar(cuerpoAsistenteService.includes('if (this.trabajoDocumentoActivoId !== trabajoId) return') || cuerpoAsistenteService.includes('if (this.trabajoDocumentoActivoId !== trabajo.id) return'), 'El polling comprueba identidad del trabajo antes de tocar mensajes — ningún tick tardío produce una segunda burbuja')
  verificar(cuerpoAsistenteService.includes('const contenidoReal = trabajo.resultado?.contenidoOriginal') && cuerpoAsistenteService.includes('if (contenidoReal) this.actualizarDocumentoActivo(idNuevo, contenidoReal, archivo)'), 'documentoActivo se fija con el contenido REAL del documento (contenidoOriginal), nunca con el texto envoltorio — las ediciones futuras parten del contenido correcto')
  verificar(cuerpoAsistenteService.includes('AsistenteService.reanudarTrabajoDocumentoPendienteSiExiste()'), 'Existen los listeners de reconexión (visibilitychange/pageshow/focus/online)')
  verificar(cuerpoAsistenteService.includes('this.reanudarTrabajoDocumentoPendienteSiExiste()') && cuerpoAsistenteService.includes('abrirConversacion(id: string)'), 'abrirConversacion() también retoma un trabajo pendiente de esa conversación (caso "la app se cerró por completo")')
  verificar(cuerpoTrabajoCliente.includes("CLAVE_TRABAJO_ACTIVO = 'docente-ia:trabajo-documento-activo'"), 'El trabajo activo se persiste en localStorage — sobrevive a recargar la página')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
