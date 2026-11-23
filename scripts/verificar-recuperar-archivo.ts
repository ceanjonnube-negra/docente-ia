// scripts/verificar-recuperar-archivo.ts
//
// B1 — recuperar el archivo ORIGINAL (Word/PDF) desde una tarjeta del Chat
// cuyo enlace firmado ya venció, con la sesión vigente y sin regenerarlo.
// recuperarArchivoPropio solo entrega un archivo cuyo registro en
// archivos_generados es del docente, está activo y vive en su carpeta del
// bucket de documentos generados; es de solo lectura. POST
// /api/archivos/descargar conserva intacto su modo actual y agrega el modo
// autenticado; la tarjeta solo cambia cuando el enlace venció.
//
// Sin red, sin credenciales, sin IA (cliente de Supabase simulado). Se
// ejecuta con `npx tsx scripts/verificar-recuperar-archivo.ts`.

import { readFileSync } from 'node:fs'
import { rutaDeUrlFirmada, validarUrlFirmadaPdf } from '../lib/documentGen/descargaPdf'

process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://proyecto.supabase.co'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const BUCKET = 'documentos-generados-ia'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const fila = (n: number, docente: string, ruta: string, extra: Partial<Record<string, unknown>> = {}) =>
  ({ id: id(n), docente_id: docente, bucket: BUCKET, ruta, nombre: ruta.split('/').pop()!.replace(/^\d+-/, ''), tipo_mime: ruta.endsWith('.pdf') ? 'application/pdf' : DOCX, estado: 'activo', tamano_bytes: 3, ...extra })

const filas = [
  fila(1, A, `${A}/1700000000000-Aviso.docx`),
  fila(2, A, `${A}/1700000000001-Aviso.pdf`),
  fila(3, B, `${B}/1700000000002-Citatorio.pdf`),
  fila(4, A, `${A}/1700000000003-Fallido.docx`, { estado: 'fallido' }),
  fila(5, A, `${B}/1700000000004-Ajeno.docx`),
  fila(6, A, `${A}/1700000000005-Borrado.pdf`),
  fila(7, A, `${A}/1700000000006-Grande.pdf`, { tamano_bytes: 5 * 1024 * 1024 }),
  fila(8, A, `${A}/1700000000007-OtroBucket.pdf`, { bucket: 'hojas-seguimiento' }),
]
const objetos = new Map<string, Buffer>(filas.filter((f) => !f.ruta.includes('Borrado')).map((f) => [`${f.bucket}/${f.ruta}`, Buffer.from('abc')]))
const escrituras: string[] = []

const clienteSimulado = {
  from(tabla: string) {
    const filtros: [string, unknown][] = []
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filtros.push([c, v]); return q },
      maybeSingle: async () => {
        if (tabla !== 'archivos_generados') return { data: null, error: null }
        const r = filas.filter((f) => filtros.every(([c, v]) => (f as Record<string, unknown>)[c] === v))
        return { data: r[0] ?? null, error: null }
      },
      insert: () => { escrituras.push(`insert ${tabla}`); return q },
      update: () => { escrituras.push(`update ${tabla}`); return q },
      delete: () => { escrituras.push(`delete ${tabla}`); return q },
      upsert: () => { escrituras.push(`upsert ${tabla}`); return q },
    }
    return q
  },
  storage: {
    from(bucket: string) {
      return {
        download: async (ruta: string) => {
          const b = objetos.get(`${bucket}/${ruta}`)
          return b ? { data: new Blob([new Uint8Array(b)]), error: null } : { data: null, error: { message: 'Object not found' } }
        },
        upload: async () => { escrituras.push('upload'); return { error: null } },
        createSignedUrl: async () => { escrituras.push('createSignedUrl'); return { data: null, error: null } },
        remove: async () => { escrituras.push('remove'); return { error: null } },
      }
    },
  },
}

async function main() {
  const { configurarClienteRegistroArchivos, recuperarArchivoPropio } = await import('../lib/documentGen/registroArchivos')
  configurarClienteRegistroArchivos(clienteSimulado as never)

  // 1. Recuperación del original con archivoId (Word y PDF).
  const word = await recuperarArchivoPropio(A, { archivoId: id(1) })
  verificar(word.ok && word.tipoMime === DOCX && word.nombre === 'Aviso.docx' && word.contenido.toString() === 'abc', '1a. Word propio por archivoId → el archivo original, sin regenerar')
  const pdf = await recuperarArchivoPropio(A, { archivoId: id(2) })
  verificar(pdf.ok && pdf.tipoMime === 'application/pdf', '1b. PDF propio por archivoId → el archivo original')

  // 2. Autorización y aislamiento entre docentes.
  const ajeno = await recuperarArchivoPropio(A, { archivoId: id(3) })
  const inexistente = await recuperarArchivoPropio(A, { archivoId: id(99) })
  verificar(!ajeno.ok && ajeno.estado === 404 && !inexistente.ok && inexistente.estado === 404 && ajeno.mensaje === inexistente.mensaje,
    '2a. Archivo de otro docente → 404, con la misma respuesta que uno inexistente')
  const delDueno = await recuperarArchivoPropio(B, { archivoId: id(3) })
  verificar(delDueno.ok, '2b. El mismo archivo sí se entrega a su dueño')
  verificar(!(await recuperarArchivoPropio(A, { archivoId: 'no-es-uuid' })).ok && !(await recuperarArchivoPropio('sin-sesion', { archivoId: id(1) })).ok,
    '2c. archivoId o docente con formato inválido → no se consulta nada útil (404)')
  const fallido = await recuperarArchivoPropio(A, { archivoId: id(4) })
  verificar(!fallido.ok && fallido.estado === 404, '2d. Registro no activo (fallido) → 404')
  const fueraDeCarpeta = await recuperarArchivoPropio(A, { archivoId: id(5) })
  verificar(!fueraDeCarpeta.ok && fueraDeCarpeta.estado === 404, '2e. Registro cuya ruta no está en la carpeta del docente → 404')
  const otroBucket = await recuperarArchivoPropio(A, { archivoId: id(8) })
  verificar(!otroBucket.ok && otroBucket.estado === 404, '2f. Registro de otro bucket → 404')

  // 3. Archivos inexistentes y límites.
  const borrado = await recuperarArchivoPropio(A, { archivoId: id(6) })
  verificar(!borrado.ok && borrado.estado === 410 && /ya no está disponible/.test(borrado.mensaje), '3a. Registro propio pero archivo eliminado de Storage → 410 «ya no está disponible»')
  const grande = await recuperarArchivoPropio(A, { archivoId: id(7) })
  verificar(!grande.ok && grande.estado === 413, '3b. Archivo mayor al límite de respuesta → 413 controlado, sin redirecciones nuevas')

  // 4. Tarjetas antiguas sin archivoId: se ubican por su URL persistida, aunque haya vencido, y se exige registro propio.
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const urlVencida = `${base}/storage/v1/object/sign/${BUCKET}/${A}/1700000000001-Aviso.pdf?token=VENCIDO`
  const ubicacion = rutaDeUrlFirmada(urlVencida, base)
  verificar(ubicacion.ok && ubicacion.bucket === BUCKET && ubicacion.ruta === `${A}/1700000000001-Aviso.pdf`, '4a. URL persistida (vencida) → bucket y ruta, con las mismas comprobaciones de origen y ruta')
  const antigua = ubicacion.ok ? await recuperarArchivoPropio(A, { bucket: ubicacion.bucket, ruta: ubicacion.ruta }) : null
  verificar(!!antigua?.ok, '4b. Tarjeta antigua con registro propio → se recupera el original')
  const urlDeOtro = rutaDeUrlFirmada(`${base}/storage/v1/object/sign/${BUCKET}/${B}/1700000000002-Citatorio.pdf?token=x`, base)
  verificar(urlDeOtro.ok && !(await recuperarArchivoPropio(A, { bucket: urlDeOtro.bucket, ruta: urlDeOtro.ruta })).ok, '4c. URL que apunta al archivo de otro docente → 404')
  const urlSinRegistro = rutaDeUrlFirmada(`${base}/storage/v1/object/sign/${BUCKET}/${A}/1600000000000-AnteriorAlRegistro.docx?token=x`, base)
  verificar(urlSinRegistro.ok && !(await recuperarArchivoPropio(A, { bucket: urlSinRegistro.bucket, ruta: urlSinRegistro.ruta })).ok,
    '4d. Archivo antiguo sin registro (aunque esté en la carpeta del docente) → no se recupera: la propiedad no puede verificarse')
  const hoja = rutaDeUrlFirmada(`${base}/storage/v1/object/sign/hojas-seguimiento/${A}/hoja.pdf?token=x`, base)
  verificar(hoja.ok && !(await recuperarArchivoPropio(A, { bucket: hoja.bucket, ruta: hoja.ruta })).ok, '4e. Otro bucket permitido para descargas (hojas) → no se recupera por este camino')
  verificar([
    'https://otro.supabase.co/storage/v1/object/sign/documentos-generados-ia/a/b.pdf?token=x',
    `${base}/storage/v1/object/sign/documentos-generados-ia/${A}/../x.pdf`,
    `${base}/storage/v1/object/public/documentos-generados-ia/${A}/x.pdf`,
    'no es una url',
  ].every((u) => !rutaDeUrlFirmada(u, base).ok), '4f. URLs arbitrarias (otro origen, "..", ruta pública, basura) → rechazadas')
  verificar(validarUrlFirmadaPdf(`${base}/storage/v1/object/sign/${BUCKET}/${A}/x.docx?token=t`, base).ok === false
    && validarUrlFirmadaPdf(`${base}/storage/v1/object/sign/${BUCKET}/${A}/x.pdf`, base).ok === false
    && validarUrlFirmadaPdf(`${base}/storage/v1/object/sign/${BUCKET}/${A}/x.pdf?token=t`, base).ok === true,
    '4g. El modo actual (sin sesión) conserva sus reglas: solo PDF y con token')

  // 5. Solo lectura.
  verificar(escrituras.length === 0, `5. Ninguna escritura en registros ni en Storage, ni URLs nuevas (intentos: ${escrituras.length})`)
  configurarClienteRegistroArchivos(null)

  // 6. Endpoint: modo actual intacto, modo autenticado solo con token.
  const ruta = readFileSync('app/api/archivos/descargar/route.ts', 'utf8')
  verificar(ruta.includes("if (datos.has('token')) return recuperarAutenticado(datos)") && ruta.includes("const validacion = validarUrlFirmadaPdf(entrada, process.env.NEXT_PUBLIC_SUPABASE_URL)"),
    '6a. Sin token, la ruta sigue exactamente el modo actual (URL firmada vigente)')
  verificar(ruta.includes("const auth = await autenticarRequestApi(typeof token === 'string' ? token : null)") && ruta.includes('recuperarArchivoPropio(auth.user.id, referencia)'),
    '6b. Con token: sesión verificada con autenticarRequestApi y archivo del usuario autenticado')
  verificar(ruta.includes("const enLinea = datos.get('modo') === 'ver' && archivo.tipoMime === 'application/pdf'"), '6c. Ver en línea solo para PDF; Word y demás se entregan como descarga')
  const modoAut = ruta.slice(ruta.indexOf('async function recuperarAutenticado'))
  verificar(!/ejecutarHerramientaDocumento|registrarArchivo|subirBuffer|createSignedUrl|crearUrlFirmada|messages\.create|Response\.redirect|status: 30\d/.test(modoAut),
    '6d. El modo autenticado no genera archivos, no registra, no llama a la IA ni redirige')
  verificar(ruta.includes("if ((origen && origen !== new URL(request.url).origin) || (sitio && sitio !== 'same-origin'))") && ruta.indexOf("if (datos.has('token'))") > ruta.indexOf('sec-fetch-site'),
    '6e. La restricción de mismo origen aplica también al modo autenticado')

  // 7. Tarjeta del Chat.
  const { accionesRecuperacionArchivo, accionesDescargaArchivo } = await import('../components/Asistente/AsistentePanel')
  verificar(JSON.stringify(accionesRecuperacionArchivo({ tipo: 'pdf' }).map((a) => a.modo)) === '["ver","descargar"]', '7a. PDF vencido → Ver y Descargar')
  verificar(JSON.stringify(accionesRecuperacionArchivo({ tipo: 'word' }).map((a) => a.modo)) === '["descargar"]', '7b. Word vencido → solo Descargar (sin prometer vista en línea)')
  verificar(accionesDescargaArchivo({ tipo: 'pdf', url: 'u', urlVer: 'v' }).map((a) => a.accion).join() === 'ver,descargar-directo', '7c. Tarjetas vigentes: mismas acciones de siempre')
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(panel.includes('if (ocultarPorVencido && referenciaVistaPrevia(archivo.url) === null) {') && panel.includes('recuperarArchivo(archivo, a.modo, avisarFallaVistaPrevia)'),
    '7d. Solo con el enlace vencido (y no en vistas previas) la tarjeta usa la recuperación')
  const util = readFileSync('lib/asistente/recuperacionArchivo.ts', 'utf8')
  verificar(util.includes("referencia.archivoId ? ['archivoId', referencia.archivoId] : ['u', referencia.url ?? '']") && util.includes("enviarFormularioPost('/api/archivos/descargar'")
    && panel.includes('enviarFormularioPost(referencia.ruta, referencia.campos, token, destino)'),
    '7e. Mismo formulario POST nativo y sesión vigente que las vistas previas (utilidad compartida); archivoId o URL persistida')
  verificar(!panel.includes('Enlace vencido — pide el documento de nuevo') && panel.includes('{ocultarPorVencido ? null : archivos.length === 1 ? ('),
    '7f. Ya no se ocultan las acciones al vencer; Compartir (usa la URL firmada) solo con el enlace vigente')

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} verificación(es) fallaron`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
