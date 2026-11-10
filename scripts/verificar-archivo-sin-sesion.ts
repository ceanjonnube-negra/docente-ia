// scripts/verificar-archivo-sin-sesion.ts
//
// Pedir un archivo de documento (nuevo, conversión o edición con formato)
// sin docente autenticado: /api/chat responde un aviso claro ANTES de
// Nivel 0 y de cualquier llamada al modelo; el texto normal y todo lo que
// ocurre con sesión válida no cambia. En modo conversión el cliente
// muestra ese aviso sin tocar el documento activo.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-archivo-sin-sesion.ts`.

import { readFileSync } from 'node:fs'
import { archivoSinSesion, MENSAJE_ARCHIVO_SIN_SESION, tipoArchivoSolicitado } from '../lib/asistente/documentos'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const DOC = '📨 CITATORIO\nTexto del citatorio.'
const PROMPT_EDICION = `El maestro pidió modificar...\nDOCUMENTO/CONTENIDO ACTUAL:\n${DOC}\n\nINSTRUCCIÓN DEL MAESTRO:\nAgrega una conclusión y guárdalo en PDF`
const CASOS: [string, Parameters<typeof tipoArchivoSolicitado>[0], string | null][] = [
  ['Documento nuevo', { mensaje: 'Genera un citatorio nuevo en PDF para los padres', esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: null }, 'pdf'],
  ['Conversión del documento activo', { mensaje: 'Pásalo a Word', esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: { tipo: 'word', documentoTexto: DOC } }, 'word'],
  ['Edición con formato', { mensaje: PROMPT_EDICION, esEdicionDocumento: true, formatoEntrega: 'pdf', finalizarArchivo: null }, 'pdf'],
  ['Texto normal', { mensaje: '¿Qué estrategias de lectura recomiendas para tercer grado?', esEdicionDocumento: false, formatoEntrega: null, finalizarArchivo: null }, null],
  ['Edición sin formato', { mensaje: PROMPT_EDICION.replace(' y guárdalo en PDF', ''), esEdicionDocumento: true, formatoEntrega: null, finalizarArchivo: null }, null],
]

// 1. Decisión del servidor, con y sin sesión.
for (const [etiqueta, entrada, esperado] of CASOS) {
  const tipo = tipoArchivoSolicitado(entrada)
  verificar(tipo === esperado, `1a. ${etiqueta}: archivo solicitado = ${esperado ?? 'ninguno'}`)
  verificar(archivoSinSesion(tipo, null) === (esperado !== null), `1b. ${etiqueta} SIN sesión → ${esperado ? 'aviso, sin modelo' : 'sigue igual (sin aviso)'}`)
  verificar(archivoSinSesion(tipo, 'docente-e2e') === false, `1c. ${etiqueta} CON sesión → comportamiento de siempre`)
}
verificar(['imagen', 'audio', 'video'].every((t) => !archivoSinSesion(t as never, null)), '1d. Imagen, audio y video no cambian (fuera de los formatos de documento)')
verificar(MENSAJE_ARCHIVO_SIN_SESION === 'Tu sesión no está activa. Inicia sesión para generar el archivo; no se creó ningún archivo.', '1e. Aviso exacto y compartido entre servidor y cliente')

// 2. Servidor: el aviso va antes de cualquier llamada al modelo.
const ruta = readFileSync('app/api/chat/route.ts', 'utf8')
const posAviso = ruta.indexOf('if (archivoSinSesion(tipoHerramientaSolicitado, userId)) {')
const posTipo = ruta.indexOf('const tipoHerramientaSolicitado = tipoArchivoSolicitado(')
const posAuth = ruta.indexOf('const userId = autenticacion?.ok')
const posNivel0 = ruta.indexOf('await clasificarNivel0(')
const llamadasModelo = [...ruta.matchAll(/client\.messages\.create\(/g)].map((m) => m.index ?? 0)
const posConversion = ruta.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado && !esEdicionDocumento) {')
verificar(posAviso > posTipo && posAviso > posAuth && posTipo > 0, '2a. El aviso se decide con la sesión ya resuelta y el archivo ya detectado')
verificar(posAviso < posNivel0 && llamadasModelo.length > 0 && llamadasModelo.every((p) => p > posAviso) && posAviso < posConversion, '2b. El aviso va antes de Nivel 0, de la conversión y de TODA llamada al modelo')
verificar(/if \(archivoSinSesion\(tipoHerramientaSolicitado, userId\)\) \{[\s\S]{0,250}return respuestaTexto\(MENSAJE_ARCHIVO_SIN_SESION\)\s*\n\s*\}/.test(ruta), '2c. Sin sesión responde el aviso y termina (sin texto alternativo)')
verificar(/if \(accessToken && !autenticacion\?\.ok\) \{\s*\n\s*return respuestaTexto\('Inicia sesión para cargar tu grupo\.'\)/.test(ruta), '2d. El aviso existente de token inválido no cambia')

// 3. Cliente: en modo conversión el aviso se ve y el documento activo queda intacto.
const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
const bloque = servicio.slice(servicio.indexOf('if (!evento.archivo && evento.texto.trim() === MENSAJE_ARCHIVO_SIN_SESION) {'), servicio.indexOf('// FINALIZAR ARCHIVO: el marcador [[DOCUMENTO_ARCHIVO:...]] ya'))
verificar(bloque.length > 50 && bloque.includes("rol: 'asistente', texto: MENSAJE_ARCHIVO_SIN_SESION") && bloque.includes('break'), '3a. Conversión sin sesión: el aviso aparece como respuesta del asistente')
verificar(!bloque.includes('documentoActivo') && !bloque.includes('actualizarDocumentoActivo') && !bloque.includes('archivo:'), '3b. El documento activo, su contenido y sus archivos no se tocan')
verificar(bloque.includes('this.ultimoIntentoEdicion = null') && bloque.includes('this.documentoFinalizandoId = null'), '3c. Sin reintento automático ni estado de conversión colgado')
verificar(/evento\.texto\.trim\(\) === MENSAJE_ARCHIVO_SIN_SESION/.test(servicio), '3d. Solo el aviso exacto se muestra así; otra respuesta sin archivo sigue el camino de siempre (no se toma como éxito)')

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
