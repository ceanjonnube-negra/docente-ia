// Hito 3d — «Abrir en Lista» desde el Chat IA: la ficha del alumno se
// sincroniza con ?tab= (también si ya está abierta), el panel se cierra y la
// conversación se conserva; la navegación manual entre pestañas sigue
// funcionando sin recargas ni consultas repetidas. Sin red, sin IA.
//   npx tsx scripts/verificar-navegacion-ficha.ts

import { readFileSync } from 'node:fs'
import { ajustarPestana, consultaConPestana, esPestana, type Pestana } from '../lib/lista/pestanasFicha'

process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9'
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'sin-clave-pruebas'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const leer = (r: string) => readFileSync(r, 'utf-8')

// Simula la ficha montada: estado inicial, cambios de ?tab (push del Chat o
// replaceState manual) y el ajuste durante el render.
function ficha(tabInicial: string | null) {
  let pestana: Pestana = esPestana(tabInicial) ? tabInicial : 'resumen'
  let sincronizada: string | null = tabInicial
  let url = tabInicial
  const render = () => { if (url !== sincronizada) ({ pestana, tabSincronizada: sincronizada } = ajustarPestana(pestana, sincronizada, url)) }
  return {
    pushDelChat: (tab: string) => { url = tab; render() },              // router.push(...?tab=)
    manual: (p: Pestana) => { pestana = p; url = new URLSearchParams(consultaConPestana(url ? `?tab=${url}` : '', p)).get('tab'); render() }, // elegirPestana
    get pestana() { return pestana },
  }
}

;(async () => {
  // 1. Sincronización con ?tab.
  verificar(esPestana('evaluaciones') && !esPestana('xyz') && !esPestana(null), '1a. Solo pestañas reales son válidas')
  const f = ficha(null)
  verificar(f.pestana === 'resumen', '1b. Sin ?tab: Resumen')
  f.pushDelChat('evaluaciones')
  verificar(f.pestana === 'evaluaciones', '1c. «Abrir en Lista» con la ficha ya abierta: cambia a Evaluaciones')
  f.manual('historial')
  verificar(f.pestana === 'historial', '1d. Navegación manual entre pestañas')
  f.pushDelChat('evaluaciones')
  verificar(f.pestana === 'evaluaciones', '1e. Después de navegar a mano, «Abrir en Lista» vuelve a abrir Evaluaciones')
  f.pushDelChat('xyz')
  verificar(f.pestana === 'evaluaciones', '1f. ?tab inválido no cambia la pestaña')
  verificar(ficha('asistencia').pestana === 'asistencia' && ficha('xyz').pestana === 'resumen', '1g. Pestaña inicial desde ?tab (como antes)')
  verificar(consultaConPestana('?tab=resumen&x=1', 'evaluaciones') === '?tab=evaluaciones&x=1' && consultaConPestana('', 'datos') === '?tab=datos', '1h. La pestaña manual se escribe en ?tab conservando los demás parámetros')

  // 2. La ficha: cableado, sin recargas ni consultas repetidas.
  const pagina = leer('app/dashboard/lista/[alumnoId]/page.tsx')
  verificar(/useSearchParams\(\)\.get\('tab'\)/.test(pagina) && /ajustarPestana\(pestana, tabSincronizada, tabUrl\)/.test(pagina) && !/window\.location\.search\)\.get\('tab'\)/.test(pagina), '2a. La ficha lee ?tab con useSearchParams y se ajusta al cambiar')
  verificar(/window\.history\.replaceState\(null, '', consultaConPestana\(window\.location\.search, p\)\)/.test(pagina) && !/onClick=\{\(\) => setPestana\(/.test(pagina) && (pagina.match(/onClick=\{\(\) => elegirPestana\(/g) ?? []).length === 6, '2b. Las 6 entradas manuales usan replaceState (sin recarga ni solicitud al servidor)')
  verificar(/\n {2}\}, \[alumnoId\]\)/.test(pagina) && !/\}, \[alumnoId, (tabUrl|pestana)/.test(pagina), '2c. La carga (incluye resultados académicos) depende solo del alumno: cambiar de pestaña no repite consultas')
  const panel = leer('components/Asistente/AsistentePanel.tsx')
  verificar(/router\.push\(ruta\)/.test(panel) && /\?tab=\$\{accion\.pestana\}/.test(panel), '2d. Mecanismo de navegación existente reutilizado (router.push con ?tab, sin recarga completa)')

  // 3. «Abrir en Lista»: cierra el panel y conserva la conversación.
  const { AsistenteService } = await import('../lib/asistente/AsistenteService')
  const svc = AsistenteService as unknown as Record<string, unknown>
  const accion = { modulo: 'lista', accion: 'abrir_registro', alumnoId: 'ana', pestana: 'evaluaciones', automatica: false }
  svc.mensajes = [
    { id: 'u1', rol: 'usuario', texto: '¿Cómo va este alumno?', creadoEn: 1 },
    { id: 'a1', rol: 'asistente', texto: 'Ana — 1 proyecto…', creadoEn: 2, datosAccionNavegacion: accion, acciones: [{ id: 'abrir_en_lista', etiqueta: 'Abrir en Lista', estilo: 'primario' }] },
  ]
  svc.panelAbierto = true
  svc.persistirConversacion = () => {}
  AsistenteService.confirmarNavegacion('a1')
  const snap = AsistenteService.obtenerSnapshot()
  verificar(snap.panelAbierto === false, '3a. Al pulsar «Abrir en Lista» se cierra el panel del Chat IA')
  verificar(JSON.stringify(snap.accionNavegacionPendiente) === JSON.stringify(accion), '3b. Navega a la ficha del alumno correcto, pestaña Evaluaciones')
  verificar(snap.mensajes.length === 2 && snap.mensajes[0].texto === '¿Cómo va este alumno?' && snap.mensajes[1].accionElegida === 'abrir_en_lista', '3c. La conversación se conserva (el botón queda marcado como usado)')
  verificar(!/alumnoEnPantalla|contextoAplicacionATexto/.test(leer('lib/lista/pestanasFicha.ts')) && /alumnoId: alumno\?\.id/.test(pagina), '3d. El contexto de alumno en pantalla no cambia')

  console.log(`\n${total - fallos}/${total} verificaciones correctas`)
  process.exit(fallos ? 1 : 0)
})()
