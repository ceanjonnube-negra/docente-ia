// scripts/verificar-captura-hoja-eval1g.ts
//
// EVAL-1G — verificación estructural (sin credenciales, sin red, sin
// datos reales) de:
//   1. app/api/proyectos-seguimiento/[id]/estado-captura/route.ts
//   2. components/Asistente/CapturaHoja.tsx
//   3. El "plumbing" de proyectoSeguimientoId (tipos.ts / aprobarBorrador.ts / chat/route.ts)
// Mismo criterio ya usado en el resto de esta familia: inspección del
// código fuente para las propiedades de seguridad/diseño que si
// fallaran silenciosamente serían graves.
//
// Se ejecuta con `npx tsx scripts/verificar-captura-hoja-eval1g.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// Quita las líneas que son ÚNICAMENTE un comentario `//` antes de
// buscar una palabra suelta — evita falsos positivos cuando el propio
// comentario explica, en prosa, que algo NO se usa (ej. "nunca lleva
// `multiple`"), que de otro modo haría pasar una prueba que en
// realidad debería fallar.
function sinComentariosDeLinea(contenido: string): string {
  return contenido
    .split('\n')
    .filter((linea) => !linea.trim().startsWith('//'))
    .join('\n')
}

const raiz = (...partes: string[]) => join(__dirname, '..', ...partes)
const estadoCapturaRuta = readFileSync(raiz('app', 'api', 'proyectos-seguimiento', '[id]', 'estado-captura', 'route.ts'), 'utf-8')
const capturaHoja = readFileSync(raiz('components', 'Asistente', 'CapturaHoja.tsx'), 'utf-8')
const asistentePanel = readFileSync(raiz('components', 'Asistente', 'AsistentePanel.tsx'), 'utf-8')
const tiposAsistente = readFileSync(raiz('lib', 'asistente', 'tipos.ts'), 'utf-8')
const aprobarBorrador = readFileSync(raiz('lib', 'planeacion', 'aprobarBorrador.ts'), 'utf-8')
const chatRoute = readFileSync(raiz('app', 'api', 'chat', 'route.ts'), 'utf-8')
const capturaHojaSinComentarios = sinComentariosDeLinea(capturaHoja)

function main() {
  // ============================================================
  // 1. estado-captura/route.ts (GET)
  // ============================================================
  verificar(!estadoCapturaRuta.includes('SERVICE_ROLE') && !estadoCapturaRuta.includes('createClient('), '1. estado-captura: no referencia SERVICE_ROLE ni crea su propio cliente')
  verificar(estadoCapturaRuta.includes('extraerBearerToken'), '2. estado-captura: se autentica vía Authorization Bearer (GET, sin body)')
  verificar(/proyecto\.docente_id !== docenteId/.test(estadoCapturaRuta), '3. estado-captura: rechaza explícitamente un proyecto que no pertenece al docente real')
  verificar(estadoCapturaRuta.includes('determinarEstadoCapturaHoja'), '4. estado-captura: usa determinarEstadoCapturaHoja (lógica pura) — nunca decide el estado inline')
  verificar(estadoCapturaRuta.includes('construirMatrizRevision') === false, '5. estado-captura: NO importa construirMatrizRevision directamente — pasa por determinarEstadoCapturaHoja, nunca la llama dos veces por separado')
  verificar(!estadoCapturaRuta.includes('.insert(') && !estadoCapturaRuta.includes('.update(') && !estadoCapturaRuta.includes('.upsert(') && !estadoCapturaRuta.includes('.delete('), '6. estado-captura: 0 escrituras — endpoint puramente de lectura')
  verificar(!/anthropic\.messages|new Anthropic/i.test(estadoCapturaRuta), '7. estado-captura: 0 llamadas IA')
  verificar(!estadoCapturaRuta.includes(".from('seguimiento_resultados')"), '8. estado-captura: nunca toca seguimiento_resultados')
  verificar(estadoCapturaRuta.includes('calcularCantidadPaginasHoja') && estadoCapturaRuta.includes('extraerFotosCapturaPendiente'), '9. estado-captura: reutiliza calcularCantidadPaginasHoja/extraerFotosCapturaPendiente — no reimplementa el conteo de páginas')
  // A diferencia de revisar-hoja, esta ruta responde 200 aunque no
  // exista todavía ninguna transcripción — nunca 409 por "sin foto".
  verificar(!/Este proyecto todavía no tiene ningún análisis/.test(estadoCapturaRuta), "10. estado-captura: nunca rechaza con 409 por falta de análisis — 'sin_fotografia'/'captura_incompleta' son estados válidos, no errores")

  // ============================================================
  // 2. CapturaHoja.tsx
  // ============================================================
  verificar(capturaHoja.includes("'use client'"), '11. CapturaHoja.tsx es un componente cliente')
  // ORDEN DE PÁGINAS — el <input> nunca lleva `multiple`.
  verificar(/type="file"/.test(capturaHojaSinComentarios) && !/multiple/.test(capturaHojaSinComentarios), '12. CapturaHoja.tsx: el <input type="file"> NUNCA lleva `multiple` en el código real (fuera de comentarios) — cada selección entrega exactamente 1 archivo, el número de página nunca depende del orden de un FileList')
  verificar(capturaHoja.includes('accept="image/*,.heic,.heif"'), '13. CapturaHoja.tsx: acepta HEIC/HEIF explícitamente además de image/* (mismo whitelist real de foto-hoja/route.ts)')
  verificar(/formData\.append\('pagina', String\(paginasCargadas \+ 1\)\)/.test(capturaHoja), '14. CapturaHoja.tsx: el número de página se calcula del estado propio del componente (paginasCargadas + 1), nunca de un índice de selección múltiple')
  // Secuencial, nunca Promise.all — cada subida se dispara desde UNA
  // selección de archivo (no multiple), así que estructuralmente no
  // puede existir un bucle que suba varias en paralelo.
  verificar(!capturaHoja.includes('Promise.all'), '15. CapturaHoja.tsx: no usa Promise.all para subidas — coherente con nunca soportar selección múltiple en un solo evento')
  verificar(capturaHoja.includes('enCursoRef'), '16. CapturaHoja.tsx: usa una guarda real (ref, no solo estado de UI) contra doble-tap')
  verificar(/if \(enCursoRef\.current\) return/.test(capturaHoja), '16b. CapturaHoja.tsx: cada acción (subir/confirmar/abrir selector) revisa la guarda ANTES de arrancar')
  // Confirmación solo por acción explícita — confirmar() nunca se
  // invoca automáticamente desde analizar()/cargarEstado()/onArchivoSeleccionado().
  verificar(!/await confirmar\(\)/.test(capturaHoja) && !/^\s*confirmar\(\)/m.test(capturaHoja), '17. CapturaHoja.tsx: confirmar() nunca se llama automáticamente en ningún flujo — solo por el onClick explícito del botón "Confirmar resultados"')
  verificar(/onClick=\{confirmar\}/.test(capturaHoja), "17b. CapturaHoja.tsx: el botón 'Confirmar resultados' es el ÚNICO disparador de confirmar()")
  // Tras confirmar, no se vuelve a ofrecer subir/confirmar.
  verificar(/estado === 'confirmado'[\s\S]*Resultados confirmados/.test(capturaHoja), "18. CapturaHoja.tsx: el estado 'confirmado' muestra un mensaje terminal, no botones de acción")
  verificar(!capturaHojaSinComentarios.includes('esCeldaBloqueante') && !capturaHojaSinComentarios.includes('construirMatrizRevision'), '19. CapturaHoja.tsx nunca IMPORTA ni llama esCeldaBloqueante/construirMatrizRevision en código real (solo se mencionan en un comentario explicando que NO se usan) — solo lee el estado ya calculado por el backend')
  verificar(capturaHoja.includes('/revisar-hoja') && capturaHoja.includes('/analizar-hoja') && capturaHoja.includes('/foto-hoja') && capturaHoja.includes('/confirmar-hoja') && capturaHoja.includes('/estado-captura'), '20. CapturaHoja.tsx llama a las 5 rutas reales existentes — ninguna lógica de negocio duplicada en el cliente')
  verificar(!/anthropic|Anthropic/i.test(capturaHoja), '21. CapturaHoja.tsx: 0 referencias a IA — solo orquesta llamadas HTTP ya existentes')
  // La pantalla EVAL-1F solo se enlaza cuando el estado es 'revision_pendiente' — nunca en los demás casos.
  verificar(/estado === 'revision_pendiente'[\s\S]{0,300}\/dashboard\/seguimiento\/\$\{proyectoId\}\/revisar/.test(capturaHoja), "22. CapturaHoja.tsx: el enlace a /dashboard/seguimiento/[id]/revisar SOLO aparece cuando estado==='revision_pendiente'")

  // ============================================================
  // 3. Wiring en AsistentePanel.tsx
  // ============================================================
  verificar(asistentePanel.includes("import CapturaHoja from './CapturaHoja'"), '23. AsistentePanel.tsx importa CapturaHoja')
  verificar(/tipoDocumento === 'hoja_evaluacion' && principal\.proyectoSeguimientoId/.test(asistentePanel), "24. AsistentePanel.tsx solo renderiza CapturaHoja cuando tipoDocumento==='hoja_evaluacion' Y proyectoSeguimientoId está presente (tarjetas viejas sin el campo no muestran la acción, nunca rompen)")

  // ============================================================
  // 4. Plumbing de proyectoSeguimientoId
  // ============================================================
  verificar(/proyectoSeguimientoId\?:\s*string/.test(tiposAsistente), '25. ArchivoGeneradoInfo.proyectoSeguimientoId es un campo opcional/aditivo')
  verificar(/hoja:\s*\{[^}]*proyectoSeguimientoId[^}]*\}/.test(aprobarBorrador), '26. aprobarBorrador.ts devuelve proyectoSeguimientoId dentro de `hoja` (ya calculado en la Fase 3, no se recalcula)')
  verificar(
    chatRoute.includes("const archivoHoja = { tipo: 'pdf'") && chatRoute.includes('proyectoSeguimientoId: resultado.hoja.proyectoSeguimientoId'),
    '27. chat/route.ts incluye proyectoSeguimientoId al construir el marcador de la tarjeta de la hoja'
  )

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
