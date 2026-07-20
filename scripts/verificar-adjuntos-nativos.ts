// scripts/verificar-adjuntos-nativos.ts
//
// Protección contra regresiones del botón de adjuntar del Chat IA —
// tercera vuelta sobre el mismo problema (ver commits anteriores:
// "menu-unico", "menu-sin-nativo"). Cada intento anterior de construir
// un menú propio delante del selector de iOS terminó mostrando DOS
// menús, porque el selector nativo de iOS no se puede evitar desde
// HTML para un <input type="file">. Decisión final de UX: nada de
// menú propio, un solo <input type="file"> nativo — que sea
// exactamente eso lo que quede en components/Asistente/AsistentePanel.tsx
// es lo único que este script comprueba, leyendo el archivo fuente
// (no hay framework de pruebas en este proyecto).
//
// Se ejecuta con `npx tsx scripts/verificar-adjuntos-nativos.ts` (o
// `npm run verificar:adjuntos-nativos`).

import { readFileSync } from 'fs'
import { join } from 'path'

const ruta = join(__dirname, '..', 'components', 'Asistente', 'AsistentePanel.tsx')
// Se descartan las líneas de comentario ("// ...") antes de buscar
// patrones — de otro modo, un comentario que simplemente MENCIONA
// `<input type="file">` (como el que documenta este mismo cambio)
// se contaría como un input real y arruinaría el conteo.
const codigo = readFileSync(ruta, 'utf-8')
  .split('\n')
  .map((linea) => linea.replace(/\/\/.*/, ''))
  .join('\n')

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

verificar(!codigo.includes('MenuAdjuntos'), 'AsistentePanel.tsx no usa ningún menú propio de adjuntos (MenuAdjuntos)')

const inputsArchivo = codigo.match(/<input\b[^>]*type="file"/g) || []
verificar(inputsArchivo.length === 1, `Existe exactamente un <input type="file"> (encontrados: ${inputsArchivo.length})`)

verificar(!codigo.includes('capture='), 'El input de adjuntar no fuerza ninguna cámara (capture) — deja que iOS ofrezca Fototeca/Tomar foto/Elegir archivo')

verificar(codigo.includes('adjuntoInputRef.current?.click()'), 'El botón de adjuntar dispara el input nativo por referencia (adjuntoInputRef)')

const llamadasClick = codigo.match(/adjuntoInputRef\.current\?\.click\(\)/g) || []
verificar(llamadasClick.length === 1, `El input de adjuntar se dispara desde un único lugar (encontrados: ${llamadasClick.length})`)

verificar(codigo.includes("accept=\"image/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx\""), 'El input acepta imágenes y documentos en una sola opción nativa (sin menú propio que los separe)')

if (fallos > 0) {
  console.error(`\n${fallos} verificación(es) fallida(s) — el botón de adjuntar del Chat IA volvió a mostrar dos menús.`)
  process.exit(1)
}
console.log('\nTodo correcto: el botón de adjuntar del Chat IA dispara un único <input type="file"> nativo, sin menú propio delante.')
