// scripts/verificar-red-seguridad-estado-programa-analitico.ts
//
// PA-5G — red de seguridad determinista por ESTADO CANÓNICO: cuando
// Nivel 0 clasifica un turno como algo distinto de programa_analitico
// (historial ambiguo/contaminado, ver auditoría PA-5G) pero el mensaje
// es una continuación trivial EXACTA (esContinuacionTrivial, mismo
// criterio ya usado dentro del bloque PA) y existe un borrador
// pendiente real para el grupo activo, /api/chat trata el turno como
// programa_analitico/gestionar de todas formas — 0 IA, sin depender de
// que Nivel 0 "recuerde" el contexto.
//
// Dos capas de prueba:
//   (a) EJECUCIÓN REAL de esContinuacionTrivial (función pura,
//       importada tal cual) contra cada mensaje de los casos A-I — no
//       es un mock, es el mismo criterio exacto que usará route.ts.
//   (b) Verificación ESTRUCTURAL de route.ts (mismo criterio ya usado
//       en verificar-trabajo-durable-programa-analitico.ts y en el
//       caso 25 de verificar-manejar-turno-programa-analitico.ts): el
//       enrutamiento vive embebido en el handler POST monolítico, no
//       es una función exportable de forma aislada sin una llamada
//       HTTP real. El comportamiento DOWNSTREAM (accion='gestionar' +
//       borrador pendiente + mensaje trivial → resumen, 0 IA) ya está
//       probado de extremo a extremo en
//       verificar-manejar-turno-programa-analitico.ts (casos PA5D-G/H) —
//       aquí se prueba específicamente el enrutamiento UPSTREAM: que
//       route.ts decide activar ese flujo incluso cuando Nivel 0 no lo
//       clasificó así.
//
// Se ejecuta con
// `npx tsx scripts/verificar-red-seguridad-estado-programa-analitico.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { esContinuacionTrivial } from '../lib/programaAnalitico/borradorProgramaAnalitico'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

const RAIZ = join(__dirname, '..')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')

async function main() {
  // ============================================================
  // (a) Ejecución REAL de esContinuacionTrivial — casos A-D, F, G (el
  //     mismo mensaje) y E (mensaje real de la tarea).
  // ============================================================

  // --- CASO A/B/C/D. continuaciones triviales EXACTAS → true ---
  for (const mensajeTrivial of ['Continua', 'continúa', 'ok', 'de acuerdo', 'sigue', 'seguir']) {
    verificar(esContinuacionTrivial(mensajeTrivial) === true, `CASO-A/B/C/D. esContinuacionTrivial("${mensajeTrivial}") === true — activaría la red de seguridad si hay borrador pendiente`)
  }

  // --- CASO E. instrucción real de otra tarea → NUNCA trivial ---
  for (const mensajeTareaReal of ['Hazme un aviso para los padres', 'Crea una planeación de fracciones', 'Hazme una imagen', '¿Cómo está Juan?']) {
    verificar(esContinuacionTrivial(mensajeTareaReal) === false, `CASO-E. esContinuacionTrivial("${mensajeTareaReal}") === false — la red de seguridad NUNCA se activa, la tarea explícita sigue su flujo normal`)
  }

  // --- CASO F. instrucción real SOBRE el propio borrador → NUNCA trivial (coincidencia EXACTA, nunca substring) ---
  for (const mensajeAjusteReal of ['continúa pero quita el contenido de narración', 'Ok, cambia el segundo contenido.', 'Sí, pero agrega fracciones.']) {
    verificar(esContinuacionTrivial(mensajeAjusteReal) === false, `CASO-F. esContinuacionTrivial("${mensajeAjusteReal}") === false — el ajuste real conserva su flujo, nunca lo intercepta la red de seguridad`)
  }

  // ============================================================
  // (b) Verificación estructural de route.ts — el enrutamiento vive
  //     embebido en el handler POST, se prueba sobre el código real.
  // ============================================================

  const idxComentarioPa5g = cuerpoChatRoute.indexOf('// PA-5G — red de seguridad determinista por ESTADO CANÓNICO')
  // Ancla en la llamada REAL a clasificarNivel0 (nunca en el texto
  // "clasificacion.intencion_principal === 'programa_analitico'", que
  // ahora también aparece DENTRO del propio bloque PA-5G, en la
  // asignación de intencionProgramaAnaliticoEfectiva).
  const idxGuardOriginal = cuerpoChatRoute.indexOf('const clasificacion = await clasificarNivel0(')
  const idxGuardEfectivo = cuerpoChatRoute.indexOf('if (intencionProgramaAnaliticoEfectiva) {')
  const idxLlamadaFinal = cuerpoChatRoute.indexOf('manejarTurnoProgramaAnalitico(supabaseUser, client, sesion, accionProgramaAnaliticoEfectiva,')

  verificar(idxComentarioPa5g > -1, 'la red de seguridad PA-5G existe en route.ts')
  verificar(
    idxComentarioPa5g > -1 && idxGuardOriginal > -1 && idxComentarioPa5g > idxGuardOriginal,
    'el bloque PA-5G vive DESPUÉS de que Nivel 0 ya clasificó (clasificacion.intencion_principal ya existe) — nunca antes, nunca lo duplica ni lo reemplaza'
  )
  verificar(cuerpoChatRoute.includes('import { esContinuacionTrivial } from '), 'route.ts importa esContinuacionTrivial (reutilizada tal cual, nunca reimplementada)')
  verificar(!/from '@\/lib\/programaAnalitico\/borradorProgramaAnalitico'\s*\n.*RESPUESTAS_TRIVIALES/.test(cuerpoChatRoute), 'route.ts nunca importa/duplica RESPUESTAS_TRIVIALES directamente — solo usa esContinuacionTrivial ya construida')

  // --- CASO H. si Nivel 0 ya clasificó programa_analitico, el comportamiento previo queda intacto (el bloque de red de seguridad nunca se evalúa) ---
  {
    const bloquePa5g = idxComentarioPa5g > -1 && idxGuardEfectivo > -1 ? cuerpoChatRoute.slice(idxComentarioPa5g, idxGuardEfectivo) : ''
    verificar(
      bloquePa5g.includes("let intencionProgramaAnaliticoEfectiva = clasificacion.intencion_principal === 'programa_analitico'") &&
        bloquePa5g.includes('if (!intencionProgramaAnaliticoEfectiva && sesion.grupo_activo_id && esContinuacionTrivial(mensaje)) {'),
      'CASO-H. intencionProgramaAnaliticoEfectiva parte del valor REAL de Nivel 0 — cuando Nivel 0 YA clasificó programa_analitico, el bloque de red de seguridad (guardado por !intencionProgramaAnaliticoEfectiva) nunca se evalúa: comportamiento previo intacto'
    )
    // Esta línea vive DENTRO de if (intencionProgramaAnaliticoEfectiva) {
    // (después de idxGuardEfectivo) — se busca en el texto completo,
    // no en bloquePa5g (que termina justo en ese guard).
    verificar(
      cuerpoChatRoute.includes('const accionProgramaAnaliticoEfectiva = accionProgramaAnaliticoRedSeguridad ?? clasificacion.accion_programa_analitico'),
      'CASO-H2. cuando la red de seguridad NO se activó (accionProgramaAnaliticoRedSeguridad=null), la acción efectiva es EXACTAMENTE la de Nivel 0 — ningún cambio de comportamiento para el camino ya existente'
    )
  }

  // --- CASO G. sin borrador pendiente, la red de seguridad NUNCA fuerza PA (accionProgramaAnaliticoRedSeguridad solo se asigna dentro del if de pendienteRedSeguridadPa) ---
  {
    const idxIfPendiente = cuerpoChatRoute.indexOf('if (pendienteRedSeguridadPa) {')
    const idxAsignacionRedSeguridad = cuerpoChatRoute.indexOf("accionProgramaAnaliticoRedSeguridad = 'gestionar'")
    verificar(
      idxIfPendiente > -1 && idxAsignacionRedSeguridad > idxIfPendiente && idxAsignacionRedSeguridad - idxIfPendiente < 200,
      "CASO-G. accionProgramaAnaliticoRedSeguridad='gestionar' solo se asigna DENTRO del if(pendienteRedSeguridadPa) — sin borrador pendiente real, intencionProgramaAnaliticoEfectiva permanece false y el turno sigue su flujo normal (Nivel 0 manda)"
    )
  }

  // --- CASO I. un turno no trivial nunca ejecuta buscarBorradorPendientePorGrupo por causa de PA-5G (el SELECT vive DENTRO del if que exige esContinuacionTrivial(mensaje)) ---
  {
    const idxCondicionTrivial = cuerpoChatRoute.indexOf('if (!intencionProgramaAnaliticoEfectiva && sesion.grupo_activo_id && esContinuacionTrivial(mensaje)) {')
    const idxSelectRedSeguridad = cuerpoChatRoute.indexOf('const pendienteRedSeguridadPa = await buscarBorradorPendientePorGrupo(supabaseUser, sesion.grupo_activo_id)')
    verificar(
      idxCondicionTrivial > -1 && idxSelectRedSeguridad > idxCondicionTrivial && idxSelectRedSeguridad - idxCondicionTrivial < 300,
      'CASO-I. el SELECT de red de seguridad (buscarBorradorPendientePorGrupo) vive DENTRO del if que ya exige esContinuacionTrivial(mensaje)===true — un mensaje normal no trivial nunca lo ejecuta por causa de PA-5G'
    )
  }

  // --- No duplica lógica de manejarTurnoProgramaAnalitico, no carga currículo, no consulta deltas, no genera resumen aquí ---
  {
    const bloquePa5gCompleto = idxComentarioPa5g > -1 && idxGuardEfectivo > -1 ? cuerpoChatRoute.slice(idxComentarioPa5g, idxGuardEfectivo) : ''
    verificar(
      !bloquePa5gCompleto.includes('recuperarCatalogoCurricularCerrado') &&
        !bloquePa5gCompleto.includes('interpretarAjusteBorrador') &&
        !bloquePa5gCompleto.includes('textoYaHayBorradorPendiente') &&
        !bloquePa5gCompleto.includes('.deltas'),
      'el bloque PA-5G no duplica lógica de manejarTurnoProgramaAnalitico — no carga currículo, no interpreta ajustes, no construye el resumen ni toca deltas aquí; solo decide el enrutamiento'
    )
  }

  // --- El MISMO bloque PA existente se reutiliza (no hay un segundo return/llamada separada para la red de seguridad) ---
  {
    verificar(idxLlamadaFinal > idxGuardEfectivo, 'existe exactamente UNA llamada final a manejarTurnoProgramaAnalitico dentro del bloque — la red de seguridad reutiliza el mismo camino, nunca uno paralelo')
    const cantidadLlamadasManejarTurno = (cuerpoChatRoute.match(/await manejarTurnoProgramaAnalitico\(/g) || []).length
    verificar(cantidadLlamadasManejarTurno === 2, 'manejarTurnoProgramaAnalitico se invoca exactamente 2 veces en route.ts: 1 dentro de after() (trabajo durable PA-5F) y 1 en el camino síncrono — PA-5G no agrega una tercera')
  }

  // --- Observabilidad: log mínimo, sin contenido sensible ---
  {
    verificar(
      cuerpoChatRoute.includes('console.log(`[PROGRAMA_ANALITICO] redSeguridadEstado=true grupoId=${sesion.grupo_activo_id} motivo=continuacion_trivial_con_pendiente`)'),
      'el log de activación es mínimo: redSeguridadEstado=true, grupoId, motivo — nunca texto del borrador/contexto_notas/deltas/nombres'
    )
  }

  // --- PA-5F sigue intacto: el routing durable sigue usando la acción efectiva sin cambiar de semántica (adjunto real sigue siendo obligatorio para el camino durable) ---
  {
    verificar(
      cuerpoChatRoute.includes("if (accionProgramaAnaliticoEfectiva === 'gestionar' && adjuntoProgramaAnalitico && sesion.grupo_activo_id && userId) {"),
      'PA-5F: el routing durable sigue exigiendo accion=gestionar + adjunto real — la red de seguridad (mensaje trivial, sin imagen) nunca puede activar por sí sola el camino durable, solo el síncrono normal'
    )
  }

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
