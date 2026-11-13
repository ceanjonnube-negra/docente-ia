// scripts/verificar-acciones-pdf.tsx
//
// Tarjeta de archivo del Chat IA: TODO PDF (genérico del CASO 3 y de
// conversiones, planeación, hoja de evaluación) tiene "Ver PDF" (urlVer,
// sin attachment) y "Descargar PDF" (URL firmada con `download`,
// navegación directa: sin Blob, ObjectURL ni window.open de respaldo);
// "Compartir" sigue aparte. Un PDF antiguo sin urlVer conserva la
// descarga directa. Word, PowerPoint y Excel no cambian.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-acciones-pdf.tsx`.

import { readFileSync } from 'node:fs'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const URL_DESCARGA = 'https://e2e.supabase.co/storage/v1/object/sign/documentos/a.pdf?token=t&download=CITATORIO.pdf'
const URL_VER = 'https://e2e.supabase.co/storage/v1/object/sign/documentos/a.pdf?token=v'

async function main() {
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
  const { accionesDescargaArchivo, descargarPdfDirecto, referenciaVistaPrevia } = await import('../components/Asistente/AsistentePanel')
  const { validarUrlFirmadaPdf } = await import('../lib/documentGen/descargaPdf')
  const resumen = (a: ReturnType<typeof accionesDescargaArchivo>) => a.map((x) => `${x.accion}:${x.url === URL_VER ? 'VER' : x.url === URL_DESCARGA ? 'DESCARGA' : x.url}:${x.etiqueta}`).join(' | ')

  // 1. PDF genérico (CASO 3 / conversión), de planeación y de hoja de evaluación.
  const esperadoConVer = `ver:VER:👁️ Ver PDF | descargar-directo:DESCARGA:⬇️ Descargar PDF`
  verificar(resumen(accionesDescargaArchivo({ tipo: 'pdf', url: URL_DESCARGA, urlVer: URL_VER })) === esperadoConVer, '1a. PDF genérico (CASO 3, conversión): Ver PDF + Descargar PDF directo')
  verificar(resumen(accionesDescargaArchivo({ tipo: 'pdf', url: URL_DESCARGA, urlVer: URL_VER, tipoDocumento: 'planeacion' } as never)) === esperadoConVer, '1b. PDF de planeación: mismas dos acciones')
  verificar(resumen(accionesDescargaArchivo({ tipo: 'pdf', url: URL_DESCARGA, urlVer: URL_VER, tipoDocumento: 'hoja_evaluacion' } as never)) === esperadoConVer, '1c. PDF de hoja de evaluación: mismas dos acciones')
  verificar(resumen(accionesDescargaArchivo({ tipo: 'pdf', url: URL_DESCARGA })) === 'descargar-directo:DESCARGA:⬇️ Descargar PDF', '1d. PDF antiguo sin urlVer: descarga directa segura (sin blob), sin "Ver"')

  // 2. Demás formatos: sin cambios (su descarga de siempre).
  for (const [tipo, etiqueta] of [['word', 'Word'], ['powerpoint', 'PowerPoint'], ['excel', 'Excel']]) {
    verificar(resumen(accionesDescargaArchivo({ tipo, url: 'U' } as never)) === `descargar:U:⬇️ Descargar ${etiqueta}`, `2. ${etiqueta}: un solo botón "Descargar ${etiqueta}" con la descarga de siempre`)
  }

  // 3. Mecanismos (código fuente).
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  const directo = panel.slice(panel.indexOf('function descargarPdfDirecto('), panel.indexOf('// VISTAS PREVIAS DE PLANEACIÓN'))
  verificar(directo.length > 50 && !/fetch\(|Blob|createObjectURL|revokeObjectURL|window\.open/.test(directo) && /formulario\.method = 'POST'/.test(directo) && /formulario\.action = '\/api\/archivos\/descargar'/.test(directo) && /campo\.value = url/.test(directo) && /formulario\.submit\(\)/.test(directo), '3a. Descargar PDF: formulario POST nativo a la ruta del mismo origen, sin fetch, Blob, ObjectURL ni window.open')
  verificar(/a\.accion === 'ver' \? window\.open\(a\.url, '_blank'\)\s*\n\s*: a\.accion === 'descargar-directo' \? descargarPdfDirecto\(a\.url\)\s*\n\s*: descargarArchivo\(a\.url, archivo\.nombre\)/.test(panel), '3b. Cada acción ejecuta solo su mecanismo (Ver abre urlVer; Descargar, la URL de descarga)')
  verificar(!panel.includes("'Ver / Descargar PDF'") && !/archivo\.tipoDocumento && archivo\.urlVer/.test(panel), '3c. Ya no existe el botón combinado ni la condición limitada a planeación/hoja')
  verificar(/onClick=\{\(\) => compartir\(archivos\[0\]\)\}/.test(panel) && /: compartirArchivo\(archivo, \(\) =>/.test(panel) && panel.includes("'📤 Compartir'"), '3d. Compartir sigue como acción independiente (archivos firmados: compartirArchivo de siempre)')
  const herramientas = readFileSync('lib/documentGen/herramientas.ts', 'utf8')
  const almacenamiento = readFileSync('lib/documentGen/almacenamiento.ts', 'utf8')
  verificar(/url = await medirEtapa\(`\$\{etiqueta\}:url-firmada`, \(\) => reintentarEtapa\(\(\) => crearUrlFirmada\(sb, ruta, nombre\), 3\)\)/.test(herramientas) && /urlVer = await medirEtapa\(`\$\{etiqueta\}:url-firmada-ver`, \(\) => crearUrlFirmada\(sb, ruta\)\)/.test(herramientas), '3e. Pipeline: url se firma CON nombre de descarga; urlVer, sin él')
  verificar(/createSignedUrl\(ruta, VENCIMIENTO_URL_SEGUNDOS, nombreDescarga \? \{ download: nombreDescarga \} : undefined\)/.test(almacenamiento), '3f. crearUrlFirmada pide `download` (Content-Disposition: attachment) solo cuando hay nombre de descarga')

  // 4. Mecanismo de descarga según el tipo REAL de URL que produce el Chat
  // (comportamiento, con un document simulado que registra lo creado).
  const BASE = 'https://e2eproyecto000000000.supabase.co'
  const firmada = (bucket: string, ruta: string, nombre: string) => `${BASE}/storage/v1/object/sign/${bucket}/d0000000-0000-4000-8000-0000000000d0/1794524701227-${ruta}?token=t&download=${nombre}`
  const reales = {
    generico: firmada('documentos-generados-ia', 'CITATORIO.pdf', 'CITATORIO.pdf'),
    planeacionDefinitiva: firmada('documentos-generados-ia', 'PLANEACION_DIDACTICA.pdf', 'PLANEACION_DIDACTICA.pdf'),
    hojaDefinitiva: firmada('hojas-seguimiento', 'hoja-seguimiento-HS-001.pdf', 'hoja-seguimiento-HS-001.pdf'),
    vistaPreviaPlaneacion: '/api/planeaciones/vista-previa-documento?tipoDocumento=planeacion&token=eyJ.ficticio&datos=H4sI%2Bficticio&modo=descargar',
    vistaPreviaHoja: '/api/planeaciones/vista-previa-hoja?tipoDocumento=hoja_evaluacion&token=eyJ.ficticio&datos=eyJ%3Dficticio&modo=descargar',
  }
  type Elemento = Record<string, unknown> & { tag: string; hijos: Elemento[]; clic: number; enviado: number }
  const creados: Elemento[] = []
  ;(globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      const el: Elemento = { tag, hijos: [], clic: 0, enviado: 0, style: {} } as Elemento
      Object.assign(el, { appendChild: (h: Elemento) => el.hijos.push(h), click: () => { el.clic++ }, submit: () => { el.enviado++ }, remove: () => {} })
      creados.push(el)
      return el
    },
    body: { appendChild: () => {} },
  }
  const descargar = (url: string) => { creados.length = 0; descargarPdfDirecto(url); return creados[0] }
  for (const [tipo, url] of [['PDF genérico firmado', reales.generico], ['PDF definitivo de planeación', reales.planeacionDefinitiva], ['Hoja definitiva firmada', reales.hojaDefinitiva]] as const) {
    const el = descargar(url)
    verificar(el.tag === 'form' && el.method === 'POST' && el.action === '/api/archivos/descargar' && el.enviado === 1 && (el.hijos[0] as Elemento).value === url && validarUrlFirmadaPdf(url, BASE).ok, `4a. ${tipo}: formulario POST a /api/archivos/descargar, y el endpoint la acepta`)
  }
  // Vistas previas: rutas internas que la tarjeta abre por POST con la
  // sesión vigente (ver verificar-vista-previa-sin-token); aquí solo se
  // comprueba que se reconocen y que su token histórico se descarta.
  for (const [tipo, url] of [['Vista previa de planeación', reales.vistaPreviaPlaneacion], ['Vista previa de hoja de evaluación', reales.vistaPreviaHoja]] as const) {
    const ref = referenciaVistaPrevia(url)
    verificar(!!ref && ref.ruta === url.split('?')[0] && !ref.campos.some(([c]) => c === 'token') && ref.campos.some(([c, v]) => c === 'modo' && v === 'descargar'), `4b. ${tipo}: se reconoce como vista previa (POST con sesión vigente) y su token histórico se descarta`)
  }
  const externos = ['//evil.example/x.pdf', '/\\evil.example/x.pdf', 'https://evil.example/api/planeaciones/vista-previa-hoja?x=1', 'javascript:alert(1)', 'data:application/pdf;base64,AAAA', '/api/planeaciones/vista-previa-documento-word?token=x', '/api/otra-ruta?x=1', ' /api/planeaciones/vista-previa-hoja?x=1', '/api/planeaciones/vista-previa-hoja?x=1 y']
  verificar(externos.filter((u) => !u.startsWith('/api/planeaciones/vista-previa-documento-word')).every((u) => referenciaVistaPrevia(u) === null && descargar(u).tag === 'form'), '4c. "//", "/\\", esquemas raros, externos y otras rutas nunca se tratan como vista previa (van al formulario, que los valida)')
  verificar(externos.every((u) => !validarUrlFirmadaPdf(u, BASE).ok), '4d. ...y el endpoint los rechaza todos')
  const rutaChat = readFileSync('app/api/chat/route.ts', 'utf8')
  const plantillas = [...rutaChat.matchAll(/`(\/api\/planeaciones\/vista-previa-[a-z-]+\?[^`]*)`/g)].map((m) => m[1].replace(/\$\{[^}]+\}/g, 'X'))
  verificar(plantillas.length === 5 && plantillas.every((u) => referenciaVistaPrevia(u) !== null && !/token/i.test(u)), `4e. Las 5 URL de vista previa que construye /api/chat se reconocen y no llevan credenciales (${plantillas.length})`)

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
