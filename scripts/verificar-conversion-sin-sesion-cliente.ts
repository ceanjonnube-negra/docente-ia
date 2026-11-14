// scripts/verificar-conversion-sin-sesion-cliente.ts
//
// Conversión del documento activo ("Pásalo a PDF") sin sesión, en el
// AsistenteService REAL: el servidor responde el aviso controlado
// (MENSAJE_ARCHIVO_SIN_SESION) y el motor lo entrega como
// respuesta-parcial + respuesta-final sin archivo. Se comprueba el
// estado del cliente: un único aviso, documento activo intacto y estados
// de conversión liberados. Otra respuesta sin archivo no se toma como
// aviso ni como éxito.
//
// Sin red, sin credenciales, sin IA (se inyectan los eventos que emite
// el motor). Se ejecuta con
// `npx tsx scripts/verificar-conversion-sin-sesion-cliente.ts`.

// Módulo (no script global): sus nombres no chocan con otros scripts.
export {}

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

// Entorno mínimo de navegador: localStorage en memoria y variables
// públicas ficticias (el cliente de Supabase nunca llega a la red).
process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
const almacen = new Map<string, string>()
const g = globalThis as unknown as Record<string, unknown>
g.window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } }, addEventListener() {}, removeEventListener() {} }
g.localStorage = (g.window as { localStorage: unknown }).localStorage

type Mensaje = { id: string; rol: string; texto: string; creadoEn: number; archivo?: unknown }
type Estado = {
  mensajes: Mensaje[]
  documentoActivo: { id: string; texto: string; archivosGenerados?: Record<string, unknown>; ultimoFormatoGenerado?: string } | null
  editandoDocumentoId: string | null
  documentoFinalizandoId: string | null
  textoDocumentoFinalizando: string | null
  intentosFinalizacionActual: number
  ultimoIntentoEdicion: unknown
  generando: boolean
  turnoUsuarioPendiente: boolean
  manejarEventoMotor(evento: unknown): void
}

async function main() {
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const { MENSAJE_ARCHIVO_SIN_SESION } = await import('../lib/asistente/documentos')
  const servicio = AsistenteService as unknown as Estado

  const CITATORIO = '📨 CITATORIO\n\nEstimados padres de familia:\n- Reunión: viernes 13 de noviembre, 9:00\n\nAtentamente, la dirección.'
  const ARCHIVO_PREVIO = { word: { tipo: 'word', nombre: 'CITATORIO.docx', url: 'https://ejemplo.invalid/a.docx' } }

  // Estado justo después de "Pásalo a PDF" con un documento activo
  // (lo que deja enviarComoFinalizacion).
  const prepararConversion = () => {
    servicio.mensajes = [
      { id: 'u1', rol: 'usuario', texto: 'Redacta un citatorio', creadoEn: 1 },
      { id: 'doc', rol: 'asistente', texto: CITATORIO, creadoEn: 2 },
      { id: 'u2', rol: 'usuario', texto: 'Pásalo a PDF', creadoEn: 3 },
    ]
    servicio.documentoActivo = { id: 'doc', texto: CITATORIO, archivosGenerados: { ...ARCHIVO_PREVIO }, ultimoFormatoGenerado: 'word' }
    servicio.editandoDocumentoId = 'doc'
    servicio.documentoFinalizandoId = 'doc'
    servicio.textoDocumentoFinalizando = CITATORIO
    servicio.intentosFinalizacionActual = 0
    servicio.ultimoIntentoEdicion = { idDocumento: 'doc', textoParaModelo: '', finalizarArchivo: { tipo: 'pdf', documentoTexto: CITATORIO, textoOriginal: 'Pásalo a PDF' } }
    servicio.generando = true
    servicio.turnoUsuarioPendiente = false
  }

  // 1. Aviso sin sesión: lo que emite el motor con respuestaTexto(aviso).
  prepararConversion()
  servicio.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: MENSAJE_ARCHIVO_SIN_SESION })
  verificar(servicio.mensajes.length === 3 && servicio.mensajes[1].texto === CITATORIO, '1a. respuesta-parcial: no abre otra burbuja y el documento conserva su texto')
  servicio.manejarEventoMotor({ tipo: 'respuesta-final', texto: MENSAJE_ARCHIVO_SIN_SESION })
  const avisos = servicio.mensajes.filter((m) => m.texto === MENSAJE_ARCHIVO_SIN_SESION)
  verificar(avisos.length === 1 && avisos[0].rol === 'asistente' && servicio.mensajes[servicio.mensajes.length - 1] === avisos[0], '1b. respuesta-final: se agrega UN solo aviso, como respuesta del asistente')
  verificar(servicio.mensajes.length === 4 && servicio.mensajes[1].texto === CITATORIO && servicio.mensajes[1].archivo === undefined, '1c. La burbuja del citatorio sigue igual y sin tarjeta de PDF')
  const activo = servicio.documentoActivo
  verificar(activo?.id === 'doc' && activo.texto === CITATORIO && JSON.stringify(activo.archivosGenerados) === JSON.stringify(ARCHIVO_PREVIO) && activo.ultimoFormatoGenerado === 'word', '1d. Documento activo intacto: mismo id, texto, archivos y último formato')
  verificar(servicio.editandoDocumentoId === null && servicio.documentoFinalizandoId === null && servicio.textoDocumentoFinalizando === null && servicio.intentosFinalizacionActual === 0 && servicio.ultimoIntentoEdicion === null && servicio.generando === false, '1e. Estados de conversión liberados y sin reintento pendiente')

  // 2. Otra respuesta sin archivo NO se toma como aviso: sigue el camino
  // de siempre (sin mensaje nuevo, sin archivo, documento intacto).
  prepararConversion()
  servicio.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Texto inesperado del servidor' })
  servicio.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Texto inesperado del servidor' })
  verificar(!servicio.mensajes.some((m) => m.texto === MENSAJE_ARCHIVO_SIN_SESION) && servicio.mensajes.length === 3 && servicio.mensajes[1].texto === CITATORIO && servicio.mensajes[1].archivo === undefined, '2a. Respuesta inesperada sin archivo: no se muestra como aviso ni como éxito')
  verificar(servicio.documentoActivo?.texto === CITATORIO && JSON.stringify(servicio.documentoActivo?.archivosGenerados) === JSON.stringify(ARCHIVO_PREVIO), '2b. Respuesta inesperada: el documento activo tampoco cambia')

  // 3. Con archivo (sesión válida): el camino de éxito de siempre.
  prepararConversion()
  const PDF = { tipo: 'pdf', nombre: 'CITATORIO.pdf', url: 'https://ejemplo.invalid/a.pdf' }
  servicio.manejarEventoMotor({ tipo: 'respuesta-parcial', texto: 'Documento generado correctamente.' })
  servicio.manejarEventoMotor({ tipo: 'respuesta-final', texto: 'Documento generado correctamente.', archivo: PDF })
  verificar(servicio.mensajes.length === 4 && JSON.stringify(servicio.mensajes[3].archivo) === JSON.stringify(PDF) && servicio.mensajes[1].archivo === undefined && servicio.mensajes[1].texto === CITATORIO && servicio.documentoActivo?.ultimoFormatoGenerado === 'pdf', '3a. Con sesión: el PDF llega en una respuesta nueva (el documento no se modifica) y queda como último formato')

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
