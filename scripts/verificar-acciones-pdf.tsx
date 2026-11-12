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
  const { accionesDescargaArchivo } = await import('../components/Asistente/AsistentePanel')
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
  const directo = panel.slice(panel.indexOf('function descargarPdfDirecto('), panel.indexOf('async function compartirArchivo('))
  verificar(directo.length > 50 && !/fetch\(|Blob|createObjectURL|revokeObjectURL|window\.open/.test(directo) && /enlace\.href = url/.test(directo), '3a. Descargar PDF: navegación directa a la URL, sin fetch, Blob, ObjectURL ni window.open')
  verificar(/a\.accion === 'ver' \? window\.open\(a\.url, '_blank'\)\s*\n\s*: a\.accion === 'descargar-directo' \? descargarPdfDirecto\(a\.url, archivo\.nombre\)\s*\n\s*: descargarArchivo\(a\.url, archivo\.nombre\)/.test(panel), '3b. Cada acción ejecuta solo su mecanismo (Ver abre urlVer; Descargar, la URL de descarga)')
  verificar(!panel.includes("'Ver / Descargar PDF'") && !/archivo\.tipoDocumento && archivo\.urlVer/.test(panel), '3c. Ya no existe el botón combinado ni la condición limitada a planeación/hoja')
  verificar(/compartirArchivo\(archivos\[0\]/.test(panel) && panel.includes("'📤 Compartir'"), '3d. Compartir sigue como acción independiente')
  const herramientas = readFileSync('lib/documentGen/herramientas.ts', 'utf8')
  const almacenamiento = readFileSync('lib/documentGen/almacenamiento.ts', 'utf8')
  verificar(/url = await medirEtapa\(`\$\{etiqueta\}:url-firmada`, \(\) => reintentarEtapa\(\(\) => crearUrlFirmada\(sb, ruta, nombre\), 3\)\)/.test(herramientas) && /urlVer = await medirEtapa\(`\$\{etiqueta\}:url-firmada-ver`, \(\) => crearUrlFirmada\(sb, ruta\)\)/.test(herramientas), '3e. Pipeline: url se firma CON nombre de descarga; urlVer, sin él')
  verificar(/createSignedUrl\(ruta, VENCIMIENTO_URL_SEGUNDOS, nombreDescarga \? \{ download: nombreDescarga \} : undefined\)/.test(almacenamiento), '3f. crearUrlFirmada pide `download` (Content-Disposition: attachment) solo cuando hay nombre de descarga')

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
