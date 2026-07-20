// scripts/verificar-menu-adjuntos.ts
//
// Protección contra regresiones del menú de adjuntos del Chat IA
// (RFC-CHAT-ADJUNTOS-003, sección "PROTECCIÓN CONTRA REGRESIONES"): el
// botón de cámara del Chat IA debe abrir siempre y únicamente estas 3
// opciones, en este orden — nunca el selector nativo del sistema
// operativo (que agregaría "Complementos"/"Inteligencia"/"Compartir" u
// otras extensiones) ni un panel inferior.
//
// No hay framework de pruebas en este proyecto (sin Jest/Vitest); este
// script sigue el mismo patrón ya usado en la sesión para verificar
// lógica pura sin necesitar credenciales reales: se ejecuta con
// `npx tsx scripts/verificar-menu-adjuntos.ts` (o `npm run
// verificar:menu-adjuntos`) y termina con código de salida distinto de
// cero si el contrato se rompe.

import { OPCIONES_ADJUNTO_CHAT } from '../lib/asistente/menuAdjuntosChat'

const ESPERADO = [
  { id: 'camara', titulo: 'Tomar foto' },
  { id: 'fotos', titulo: 'Fotos' },
  { id: 'archivos', titulo: 'Archivos' },
]

const PROHIBIDAS = ['complementos', 'inteligencia', 'compartir', 'más', 'more', 'extensiones']

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

verificar(OPCIONES_ADJUNTO_CHAT.length === 3, `Son exactamente 3 opciones (encontradas: ${OPCIONES_ADJUNTO_CHAT.length})`)

ESPERADO.forEach((esperado, i) => {
  const real = OPCIONES_ADJUNTO_CHAT[i]
  verificar(!!real && real.id === esperado.id, `Opción ${i + 1} es "${esperado.id}" (encontrada: ${real?.id ?? 'ninguna'})`)
  verificar(!!real && real.titulo === esperado.titulo, `Opción ${i + 1} se titula "${esperado.titulo}" (encontrado: ${real?.titulo ?? 'ninguno'})`)
})

const camara = OPCIONES_ADJUNTO_CHAT.find((o) => o.id === 'camara')
verificar(camara?.capture === 'environment', 'Cámara abre la cámara trasera directamente (capture=environment)')
verificar(camara?.accept === 'image/*', 'Cámara solo acepta imágenes')

const archivos = OPCIONES_ADJUNTO_CHAT.find((o) => o.id === 'archivos')
;['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'].forEach((ext) => {
  verificar(!!archivos?.accept.includes(ext), `Archivos acepta ${ext}`)
})

// Causa raíz real del "segundo menú" (el selector nativo del sistema
// operativo apareciendo encima del menú propio, con textos como
// "Fototeca"/"Tomar foto"/"Seleccionar archivos"): en iOS/Android, un
// <input type="file"> sin `capture` dispara el selector nativo del
// sistema en cuanto (a) su `accept` mezcla imágenes con documentos, o
// (b) tiene `multiple` — ambas cosas hacen que el teléfono pregunte
// otra vez "¿de dónde sacas esto?" encima del menú propio. Nunca deben
// volver a pasar para Fotos/Archivos.
verificar(!archivos?.accept.includes('image/*'), 'Archivos NO mezcla el comodín image/* (dispara el selector nativo)')
verificar(!/\.(jpe?g|png|heic|heif|gif|webp)\b/i.test(archivos?.accept || ''), 'Archivos NO incluye ninguna extensión de imagen (esa mezcla también dispara el selector nativo)')
verificar(!archivos?.multiple, 'Archivos NO permite selección múltiple (eso también dispara el selector nativo)')

const fotos = OPCIONES_ADJUNTO_CHAT.find((o) => o.id === 'fotos')
verificar(!fotos?.multiple, 'Fotos NO permite selección múltiple (con "multiple" el sistema mostraba su propio selector)')
verificar(!fotos?.capture, 'Fotos no fuerza la cámara (debe ir directo a la galería)')

const titulosNormalizados = OPCIONES_ADJUNTO_CHAT.map((o) => o.titulo.toLowerCase())
PROHIBIDAS.forEach((prohibida) => {
  verificar(!titulosNormalizados.some((t) => t.includes(prohibida)), `Ninguna opción se llama "${prohibida}" (menú nativo del sistema)`)
})

if (fallos > 0) {
  console.error(`\n${fallos} verificación(es) fallida(s) — el menú de adjuntos del Chat IA cambió de forma inesperada.`)
  process.exit(1)
}
console.log('\nTodo correcto: el menú de adjuntos del Chat IA mantiene exactamente Tomar foto / Fotos / Archivos, sin selector nativo duplicado.')
