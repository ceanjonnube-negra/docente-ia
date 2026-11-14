// scripts/verificar-copiar-respuesta.ts
//
// "Copiar" en las respuestas del Chat IA: qué texto se copia
// (textoParaCopiar), cómo llega al portapapeles (Clipboard API con
// alternativa para Safari), que contenidoDocumento sobrevive a guardar y
// restaurar la conversación (persistencia existente, localStorage) y que
// el panel muestra una sola acción por respuesta terminada.
//
// Sin red, sin credenciales, sin IA. Se ejecuta con
// `npx tsx scripts/verificar-copiar-respuesta.ts`.

import { readFileSync } from 'node:fs'
import { copiarAlPortapapeles, markdownATexto, textoParaCopiar } from '../lib/asistente/copiarRespuesta'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  console.log(`${condicion ? '✓' : '✗'} ${mensaje}`)
  if (!condicion) fallos++
}

const asistente = (texto: string, contenidoDocumento?: string) => ({ rol: 'asistente' as const, texto, contenidoDocumento })
const CITATORIO = '📨 CITATORIO\n\nEstimados padres de familia:\n- Fecha: 12 de noviembre\n- Hora: 8:00\n\nAgradecemos su puntualidad y compromiso con la educación de sus hijos.'

async function main() {
  // 1. Qué se copia.
  verificar(textoParaCopiar({ rol: 'usuario', texto: 'Hola' }) === null, '1a. Mensaje del docente → sin "Copiar"')
  verificar(textoParaCopiar(asistente('')) === null && textoParaCopiar(asistente('   \n ')) === null, '1b. Respuesta vacía → sin "Copiar"')
  verificar(textoParaCopiar(asistente('Documento generado correctamente.')) === null, '1c. Documento entregado solo como archivo, histórico sin contenidoDocumento → sin "Copiar" (no se reconstruye)')
  verificar(textoParaCopiar(asistente('Documento generado correctamente.', CITATORIO)) === CITATORIO, '1d. Documento entregado como archivo con contenidoDocumento → su texto original completo')
  verificar(textoParaCopiar(asistente(CITATORIO)) === CITATORIO, '1e. Vista previa de documento formal → su texto tal cual (líneas, viñetas, párrafos)')
  const md = '## Actividad\n\n**Objetivo:** leer *en voz alta*.\n\n* Paso uno\n* Paso dos\n1. Cierre\n\n> Nota breve\n\nFuente: [SEP](https://www.sep.gob.mx)'
  verificar(textoParaCopiar(asistente(md)) === 'Actividad\n\nObjetivo: leer en voz alta.\n\n- Paso uno\n- Paso dos\n1. Cierre\n\nNota breve\n\nFuente: SEP', '1f. Markdown → texto legible: sin #, ** ni *, listas y párrafos conservados, enlaces como su texto')
  verificar(markdownATexto('```\nconst total = *a* + b_c\n```') === 'const total = *a* + b_c', '1g. Bloque de código: contenido intacto (solo se quitan las cercas)')
  verificar(markdownATexto('| Alumno | Nivel |\n|---|---|\n| Ana | 4 |') === '| Alumno | Nivel |\n| Ana | 4 |', '1h. Tabla: filas intactas (solo se quita la línea de separación)')
  verificar(markdownATexto('nombre_completo y 3 * 4 = 12') === 'nombre_completo y 3 * 4 = 12', '1i. Guiones bajos dentro de palabras y "*" aritmético no se alteran')
  verificar(markdownATexto('Completa: El ______ es azul y el ____ es verde.') === 'Completa: El ______ es azul y el ____ es verde.', '1k. Espacios para completar ("______") se conservan completos')
  verificar(markdownATexto('Si 3 * 4 > 10 y 2 < 5, entonces x_1 + x_2 = 7; 2*3*4 = 24') === 'Si 3 * 4 > 10 y 2 < 5, entonces x_1 + x_2 = 7; 2*3*4 = 24', '1l. Expresiones matemáticas y comparaciones intactas')
  verificar(markdownATexto('Usa `__init__` y `f(*args, **kw)`; **2 + 2 = 4**') === 'Usa __init__ y f(*args, **kw); 2 + 2 = 4', '1m. Código en línea intacto; el énfasis fuera del código sí se quita')
  verificar(textoParaCopiar(asistente('Documento generado correctamente.\n')) === null && textoParaCopiar(asistente('Documento generado correctamente. [[DOCUMENTO_ARCHIVO:e30=]]')) === null, '1n. Nunca se copia solo "Documento generado correctamente." (con salto o restos de marcador)')
  const conInternos ='Listo.\n[[DOCUMENTO_ARCHIVO:eyJhYmMiOjF9]]\nDescarga: https://x.supabase.co/storage/v1/object/sign/documentos/a.pdf?token=abc'
  const copiado = textoParaCopiar(asistente(conInternos)) ?? ''
  verificar(copiado.startsWith('Listo.') && !copiado.includes('[[') && !copiado.includes('/object/sign/') && !copiado.includes('token='), '1j. Nunca copia marcadores internos ni URLs firmadas')

  // 2. Portapapeles.
  type Registro = { escrito?: string; areas: number; abiertas: number; exec: number }
  const entorno = (opciones: { clipboard?: 'ok' | 'falla'; seguro?: boolean; exec?: boolean; sinDocumento?: boolean }) => {
    const r: Registro = { areas: 0, abiertas: 0, exec: 0 }
    const documento = opciones.sinDocumento ? undefined : {
      body: { appendChild: () => { r.areas++; r.abiertas++ }, removeChild: () => { r.abiertas-- } },
      createElement: () => ({ value: '', style: {} as Record<string, string>, setAttribute() {}, focus() {}, select() {}, setSelectionRange() {} }),
      execCommand: () => { r.exec++; return opciones.exec ?? false },
    }
    const navegador = opciones.clipboard ? { clipboard: { writeText: async (t: string) => { if (opciones.clipboard === 'falla') throw new Error('denegado'); r.escrito = t } } } : {}
    return { r, e: { navigator: navegador, isSecureContext: opciones.seguro ?? true, document: documento } }
  }
  let p = entorno({ clipboard: 'ok' })
  verificar(await copiarAlPortapapeles('Texto', p.e) === true && p.r.escrito === 'Texto' && p.r.areas === 0, '2a. Clipboard API disponible → copia directa, sin alternativa')
  p = entorno({ clipboard: 'falla', exec: true })
  verificar(await copiarAlPortapapeles('Texto', p.e) === true && p.r.exec === 1 && p.r.abiertas === 0, '2b. Clipboard API rechazada → alternativa con área temporal (que se retira)')
  p = entorno({ exec: true })
  verificar(await copiarAlPortapapeles('Texto', p.e) === true && p.r.exec === 1, '2c. Sin Clipboard API (Safari antiguo) → alternativa')
  p = entorno({ exec: true })
  const pendiente = copiarAlPortapapeles('Texto', p.e)
  verificar(p.r.exec === 1 && p.r.abiertas === 0, '2c2. Sin Clipboard API, la alternativa corre en el mismo toque (síncrona, antes de cualquier espera)')
  await pendiente
  const llamadas: string[] = []
  const conOrden = { navigator: { clipboard: { writeText: (t: string) => { llamadas.push(t); return Promise.resolve() } } }, isSecureContext: true }
  const promesa = copiarAlPortapapeles('Texto', conOrden)
  verificar(llamadas.length === 1, '2c3. Con Clipboard API, writeText se llama en el mismo toque (sin esperas previas)')
  await promesa
  p = entorno({ clipboard: 'ok', seguro: false, exec: true })
  verificar(await copiarAlPortapapeles('Texto', p.e) === true && p.r.escrito === undefined && p.r.exec === 1, '2d. Fuera de contexto seguro → alternativa, sin Clipboard API')
  p = entorno({ exec: false })
  verificar(await copiarAlPortapapeles('Texto', p.e) === false && p.r.abiertas === 0, '2e. Ninguna vía funciona → false (no se muestra "Copiado")')
  verificar(await copiarAlPortapapeles('Texto', entorno({ sinDocumento: true }).e) === false, '2f. Sin documento ni Clipboard API → false')

  // 3. Persistencia: contenidoDocumento se guarda y restaura por el mismo
  // mecanismo (localStorage, persistencia.ts), sin almacenamiento paralelo.
  process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'http://supabase.invalid'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'clave-ficticia'
  const almacen = new Map<string, string>()
  ;(globalThis as unknown as { window: unknown }).window = { localStorage: { getItem: (k: string) => almacen.get(k) ?? null, setItem: (k: string, v: string) => { almacen.set(k, v) }, removeItem: (k: string) => { almacen.delete(k) } } }
  const { guardarConversacion, cargarConversacionPorId } = await import('../lib/asistente/persistencia')
  guardarConversacion('conv-prueba', [
    { id: 'u1', rol: 'usuario', texto: 'Hazme un citatorio en PDF', creadoEn: 1 },
    { id: 'a1', rol: 'asistente', texto: 'Documento generado correctamente.', creadoEn: 2, contenidoDocumento: CITATORIO },
    { id: 'a2', rol: 'asistente', texto: 'Documento generado correctamente.', creadoEn: 3 },
  ], null)
  const restaurada = cargarConversacionPorId('conv-prueba')
  const a1 = restaurada?.mensajes.find((m) => m.id === 'a1')
  const a2 = restaurada?.mensajes.find((m) => m.id === 'a2')
  verificar(a1?.contenidoDocumento === CITATORIO && a1?.texto === 'Documento generado correctamente.' && textoParaCopiar(a1!) === CITATORIO, '3a. Conversación restaurada: contenidoDocumento intacto y "Copiar" copia el documento; la vista (texto) no cambia')
  verificar(a2 !== undefined && !('contenidoDocumento' in a2) && textoParaCopiar(a2) === null, '3b. Mensaje histórico sin contenidoDocumento: sigue sin él y sin "Copiar"')

  // 4. Panel y servicio (estructura).
  const panel = readFileSync('components/Asistente/AsistentePanel.tsx', 'utf8')
  verificar(/const textoCopiable = m\.rol === 'asistente' && !esUltimoGenerando \? textoParaCopiar\(m\) : null/.test(panel), '4a. "Copiar" solo en respuestas del asistente ya terminadas (nunca durante el streaming)')
  verificar((panel.match(/<BotonCopiar /g) ?? []).length === 1 && /\{textoCopiable && <BotonCopiar texto=\{textoCopiable\} \/>\}\s*\n\s*<\/div>\s*\n\s*\)\s*\n\s*\}\)\}/.test(panel), '4b. Una sola acción por respuesta, al final del mensaje (vista previa, Markdown y tarjetas intactas)')
  verificar(/copiarAlPortapapeles\(texto\)\.then\(\(ok\) => \{\s*\n\s*if \(!ok\) return\s*\n\s*setCopiado\(true\)/.test(panel), '4c. "Copiado" aparece solo si la copia se confirmó')
  const servicio = readFileSync('lib/asistente/AsistenteService.ts', 'utf8')
  verificar(/\{ \.\.\.msg, archivo: evento\.archivo, archivos: evento\.archivos, \.\.\.\(evento\.contenidoOriginal \? \{ contenidoDocumento: evento\.contenidoOriginal \} : \{\}\) \}/.test(servicio) && /this\.actualizarDocumentoActivo\(msg\.id, evento\.contenidoOriginal \?\? msg\.texto, evento\.archivo\)/.test(servicio), '4d. El documento entregado como archivo guarda su contenido en el mensaje; documentoActivo se actualiza igual que antes')
  verificar((servicio.match(/contenidoDocumento:/g) ?? []).length === 1, '4e. contenidoDocumento solo se escribe en ese punto (no afecta historial del modelo ni otros flujos); leerlo con contenidoDocumentoDe no es escribirlo')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  }
  console.log('Todas las pruebas pasaron.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
