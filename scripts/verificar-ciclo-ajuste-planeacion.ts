// scripts/verificar-ciclo-ajuste-planeacion.ts
//
// Hito 2 — ciclo de vida de los borradores de ajuste y versión canónica
// (sin red ni IA). Regresión del caso real en E2E: con la versión 2 ya
// publicada, «Muéstrame la planeación de cuentos propios» se resolvió en
// el cliente con el borrador ya aprobado, y «Reemplaza el quinto
// indicador…» lo continuó sobre la versión 1 («Cambios respecto a la
// versión 1… versión 2»). Aquí se comprueba:
//   - el cliente manda las consultas de planeaciones guardadas al servidor
//     (versión vigente), salvo el borrador de una planeación nueva;
//   - «Apruébala» enviado como edición del documento activo es la orden de
//     aprobar (determinista, sin clasificador);
//   - la ruta aplica el ciclo de vida antes de continuar un borrador: uno
//     publicado parte de la versión vigente y uno obsoleto se informa.
// El ciclo de vida contra la BD (pendiente/publicado/obsoleto, marca al
// publicar, recuperar la aprobación) está en verificar-aprobar-ajuste.ts (9).
//   npx tsx scripts/verificar-ciclo-ajuste-planeacion.ts

import { readFileSync } from 'node:fs'
import type { SupabaseClient } from '@supabase/supabase-js'
import { join } from 'node:path'
import { construirPromptEdicion } from '../lib/asistente/documentos'
import { avisoAjustePublicado, mensajeAjusteObsoleto, ordenAprobarDesdeEdicion } from '../lib/planeacion/aprobarAjuste'
import { consultaPlaneacionEnServidor } from '../lib/planeacion/detectarConsultaPlaneacion'
import { resolverConsultaContextual } from '../lib/planeacion/consultaContextual'
import { ETIQUETA_AJUSTE, PREFIJO_CONFIRMACION_APROBACION, esConfirmacionDePlaneacionGuardada, esVersionGuardadaMostrada } from '../lib/planeacion/extraerBorrador'
import { huellaBorrador } from '../lib/planeacion/modificarPlaneacion'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

const HOY = '2026-11-25'
const NOMBRE = '¡A contar historias! Elaboración de cuentos propios'
const DOCUMENTO = '📋 PLANEACIÓN DIDÁCTICA\nProyecto Didáctico: ¡A contar historias! Elaboración de cuentos propios\n\n📅 DÍA 2 — Planeamos\nTrabajo en equipos.'
const RESUMEN = '📎 RESUMEN PARA GUARDAR\nNombre: ¡A contar historias! Elaboración de cuentos propios\nIndicadores de evaluación: Uno; Dos; Tres; Cuatro; Cinco'
// Borrador de ajuste ya aprobado como versión 2 (el documento activo real del iPhone).
const BORRADOR_AJUSTE = `${DOCUMENTO}\n\n${RESUMEN}\n${ETIQUETA_AJUSTE}: «${NOMBRE}», versión 1\n\nCambios respecto a la versión 1: Día 2. ¿Quieres corregir algo más? Si está bien, dime «apruébala» y la guardo como versión 2.`
// Borrador de una planeación NUEVA, todavía sin guardar.
const BORRADOR_NUEVO = `${DOCUMENTO}\n\n${RESUMEN}`
// Versión guardada mostrada por el servidor (sin bloque de resumen).
const VERSION_CONSULTADA = `${DOCUMENTO}\n\n_Versión 2 · guardada el 25 nov 2026, 17:07 · 24 nov – 30 nov 2026_`
const PUBLICADA = `Listo: guardé «${NOMBRE}» como versión 2. La versión 1 y las anteriores se conservan para consulta.`
const YA_PUBLICADA = `Este ajuste ya está guardado como la versión 2 de «${NOMBRE}».`
const CONSULTA = 'Muéstrame la planeación de cuentos propios.'

async function main() {
  // ============================================================
  // 1. Cliente: las consultas de planeaciones guardadas van al servidor
  // ============================================================
  verificar(consultaPlaneacionEnServidor(CONSULTA, HOY, BORRADOR_AJUSTE, [PUBLICADA, YA_PUBLICADA]), '1a. Caso real: con el borrador de ajuste ya publicado como documento activo, la consulta va al servidor (versión vigente)')
  verificar(consultaPlaneacionEnServidor(CONSULTA, HOY, BORRADOR_AJUSTE, []), '1b. Con un borrador de ajuste pendiente activo, también: el servidor tiene la versión canónica')
  verificar(consultaPlaneacionEnServidor(CONSULTA, HOY, VERSION_CONSULTADA, []), '1c. Con una versión guardada como documento activo (puede ser anterior): al servidor')
  verificar(consultaPlaneacionEnServidor(CONSULTA, HOY, null, []), '1d. Sin documento activo: al servidor')
  verificar(!consultaPlaneacionEnServidor(CONSULTA, HOY, BORRADOR_NUEVO, []), '1e. Borrador de una planeación nueva sin guardar: sigue mostrándose en el cliente (solo existe ahí)')
  verificar(consultaPlaneacionEnServidor(CONSULTA, HOY, BORRADOR_NUEVO, [`${PREFIJO_CONFIRMACION_APROBACION}cuentos propios.`]), '1f. Ese borrador ya se aprobó después: al servidor (la guardada puede haber cambiado)')
  verificar(consultaPlaneacionEnServidor('¿Qué planeaciones trabajé en noviembre?', HOY, BORRADOR_AJUSTE, []) && consultaPlaneacionEnServidor('Muéstrame mi última planeación', HOY, BORRADOR_AJUSTE, []), '1g. Listados, periodos y la última planeación: al servidor')
  verificar(!consultaPlaneacionEnServidor('Reemplaza el quinto indicador de evaluación por uno sobre el trabajo colaborativo en equipo.', HOY, BORRADOR_AJUSTE, []), '1h. Un cambio no es una consulta: sigue su camino (ajuste)')
  verificar(!consultaPlaneacionEnServidor('Muéstrame el documento actual', HOY, BORRADOR_AJUSTE, []) && !consultaPlaneacionEnServidor('la 2', HOY, BORRADOR_AJUSTE, []) && !consultaPlaneacionEnServidor('Haz una planeación de cuentos', HOY, null, []),
    '1i. "El documento actual", "la 2" y crear una planeación no son consultas de una planeación guardada')

  // ============================================================
  // 2. Confirmaciones de planeación guardada (fuente única)
  // ============================================================
  verificar([PUBLICADA, YA_PUBLICADA, `${PREFIJO_CONFIRMACION_APROBACION}cuentos.`, 'Esta planeación ya está guardada. La encuentras en Planeación, Evaluación e Historial.'].every(esConfirmacionDePlaneacionGuardada) && !esConfirmacionDePlaneacionGuardada(BORRADOR_AJUSTE),
    '2a. Se reconocen las 4 confirmaciones (primera aprobación, versión publicada, aprobación recuperada, ya guardada) y nada más')
  const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
  const aprobar = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'aprobarAjuste.ts'), 'utf-8')
  verificar(aprobar.includes('`${PREFIJO_VERSION_PUBLICADA}${planeacion.nombre}» como versión') && aprobar.includes('`${PREFIJO_VERSION_YA_PUBLICADA}${numero} de «${nombre}».`'), '2b. Los mensajes de publicación usan esos mismos prefijos')

  // ============================================================
  // 3. «Apruébala» como edición del documento activo
  // ============================================================
  const historial = [
    { role: 'user', content: 'Haz más dinámica la sesión 2' }, { role: 'assistant', content: BORRADOR_AJUSTE },
    { role: 'user', content: 'Apruébala.' }, { role: 'assistant', content: PUBLICADA },
  ]
  verificar(ordenAprobarDesdeEdicion(construirPromptEdicion(PUBLICADA, 'Apruébala.'), historial), '3a. Caso real del reintento: «Apruébala.» con la confirmación como documento activo es la orden de aprobar')
  verificar(ordenAprobarDesdeEdicion(construirPromptEdicion(BORRADOR_AJUSTE, 'Apruébala'), historial.slice(0, 2)), '3b. Con el borrador como documento activo: orden de aprobar')
  verificar(ordenAprobarDesdeEdicion(construirPromptEdicion(VERSION_CONSULTADA, 'Apruébala.'), [...historial, { role: 'user', content: 'Apruébala.' }, { role: 'assistant', content: YA_PUBLICADA }]), '3c. Tras recuperar la aprobación, repetirla sigue siendo la orden')
  const examen = '📝 EXAMEN DE FRACCIONES\n1. ¿Cuánto es 1/2 + 1/4?'
  const conExamen = [...historial, { role: 'user', content: 'Hazme un examen de fracciones' }, { role: 'assistant', content: examen }]
  verificar(!ordenAprobarDesdeEdicion(construirPromptEdicion(examen, 'Apruébala'), conExamen), '3d. Con otro documento en curso (un examen), «Apruébala» sigue siendo su edición')
  verificar(ordenAprobarDesdeEdicion(construirPromptEdicion(examen, 'Aprueba la planeación'), conExamen), '3e. «Aprueba la planeación» nombra la planeación: es la orden aunque haya otro documento')
  verificar(!ordenAprobarDesdeEdicion(construirPromptEdicion(examen, 'Aprueba la planeación'), [{ role: 'user', content: 'x' }, { role: 'assistant', content: examen }]), '3f. Sin ningún borrador de planeación en la conversación: nunca es orden de aprobar')
  verificar(!ordenAprobarDesdeEdicion(construirPromptEdicion(PUBLICADA, 'Apruébala y agrega un día'), historial) && !ordenAprobarDesdeEdicion(construirPromptEdicion(PUBLICADA, '¿La apruebo?'), historial)
    && !ordenAprobarDesdeEdicion(construirPromptEdicion(BORRADOR_AJUSTE, 'Reemplaza el quinto indicador de evaluación'), historial),
    '3g. Detector estricto: órdenes compuestas, preguntas y cambios no son aprobación')
  verificar(!ordenAprobarDesdeEdicion(`DOCUMENTO/CONTENIDO ACTUAL:\nApruébala\n\nINSTRUCCIÓN DEL MAESTRO: Cambia el título`, historial), '3h. Se lee la instrucción del docente, nunca el texto del documento')

  // ============================================================
  // 4. Ruta: orden de las decisiones (sin IA)
  // ============================================================
  const iOrden = ruta.indexOf('const ordenAprobarEnEdicion = !!esEdicionDocumento && ordenAprobarDesdeEdicion(')
  const iContinuacion = ruta.indexOf('if (!ordenAprobarEnEdicion && supabaseUser && userId && (esEdicionDocumento || formatoOriginal)) {')
  const iConsultada = ruta.indexOf('if (!ordenAprobarEnEdicion && !continuacionAjuste && !ajusteDesdeEdicion && supabaseUser && userId && (esEdicionDocumento || formatoOriginal)) {')
  verificar(iOrden > 0 && iContinuacion > iOrden && iConsultada > iContinuacion, '4a. La orden de aprobar se decide antes de continuar un borrador o atender la planeación consultada, y ambos la respetan')
  const bloque = ruta.slice(iContinuacion, iConsultada)
  const iCiclo = bloque.indexOf('const ciclo = await cicloDelAjuste(supabaseUser, userId, origen)')
  verificar(iCiclo > 0 && iCiclo < bloque.indexOf('continuacionAjuste = {') && iCiclo < bloque.indexOf('ajusteDesdeEdicion = {'), '4b. El ciclo de vida (versión canónica) se consulta antes de continuar o iniciar el ajuste')
  verificar(bloque.includes("if (ciclo.estado === 'obsoleto') return respuestaTexto(mensajeAjusteObsoleto(") && bloque.includes("if (ciclo.estado === 'sin_planeacion') return respuestaTexto(MENSAJE_AJUSTE_SIN_IDENTIDAD)"), '4c. Obsoleto: se informa sin generar; sin planeación: identidad no confiable')
  const publicado = bloque.slice(bloque.indexOf("if (ciclo.estado === 'publicado') {"), bloque.indexOf('} else if (!pideCambio) {'))
  verificar(publicado.includes('ajusteDesdeEdicion = { planeacionId: origen.planeacionId') && publicado.includes('avisoCicloAjuste = avisoAjustePublicado(') && !publicado.includes('continuacionAjuste'),
    '4d. Publicado: ajuste NUEVO sobre la versión vigente (nunca continuación de su base)')
  verificar(ruta.includes('const avisoBase = avisoCicloAjuste ?? (') && ruta.includes('const base = await baseVigente(supabaseUser, resolucion.planeacion)'), '4e. El ajuste nuevo parte de baseVigente y lleva el aviso del ciclo de vida')
  verificar(ruta.includes('const ordenAprobarPlaneacion = esEdicionDocumento ? ordenAprobarEnEdicion : detectarAprobarPlaneacion('), '4f. La orden desde el documento activo llega a la aprobación sin clasificador')

  // ============================================================
  // 5. Mensajes y módulos sin IA; el cliente no depende del servidor
  // ============================================================
  const obsoleto = mensajeAjusteObsoleto(NOMBRE, 1, 2)
  verificar(obsoleto.includes('partía de la versión 1') && obsoleto.includes('vigente ahora es la 2') && obsoleto.includes('No combiné ni descarté sus cambios'), '5a. Conflicto de base obsoleta: dice ambas versiones y que no se combinó ni descartó nada')
  verificar(avisoAjustePublicado(2, 2) === 'Ese borrador ya está guardado como la versión 2; este ajuste parte de ella.' && avisoAjustePublicado(2, 3).includes('versión vigente (3)'), '5b. Aviso del borrador publicado: el ajuste parte de la versión vigente')
  const detector = readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'detectarConsultaPlaneacion.ts'), 'utf-8')
  const cliente = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'AsistenteService.ts'), 'utf-8')
  const documentosMod = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'documentos.ts'), 'utf-8')
  verificar((detector.match(/^import .* from '(.*)'$/gm) ?? []).map((l) => l.replace(/^.* from /, '')).join(',') === "'../asistente/documentos','./extraerBorrador'" && !/^import /m.test(documentosMod),
    '5c. El detector compartido es puro: solo depende de documentos (sin imports) y extraerBorrador (sin Supabase ni servidor)')
  verificar(!/anthropic|messages\.create|clasificarNivel0/.test(detector + aprobar), '5d. Ciclo de vida y detección sin IA')
  verificar(['if (!consultaGuardada && (solicitudVersion?.accion', 'if (solicitudVersion && !consultaGuardada)', 'if (!consultaGuardada && !(adjuntos && adjuntos.length > 1)', 'if (!consultaGuardada && this.documentoActivo && !this.documentoActivo.noRecuperado && !adjunto && esConsultaDocumentoActual(', 'if (this.esConsultaPlaneacionGuardada(limpio)) return false'].every((s) => cliente.includes(s)),
    '5e. Cliente: ninguna ruta local (versiones, documento nombrado, documento actual, edición) atiende una consulta de planeación guardada')

  // ============================================================
  // 6. Consulta contextual sin nombre: cliente
  // ============================================================
  const examenActivo = '📝 EXAMEN DE FRACCIONES\n1. ¿Cuánto es 1/2 + 1/4?'
  verificar(['Muéstrame la planeación', 'Enséñamela', 'Muéstramelo', '¿Cómo quedó la planeación?'].every((t) => consultaPlaneacionEnServidor(t, HOY, VERSION_CONSULTADA, [])),
    '6a. Sin nombre, con una versión guardada como documento activo: al servidor (versión vigente)')
  verificar(consultaPlaneacionEnServidor('Muéstrame la planeación', HOY, BORRADOR_AJUSTE, [PUBLICADA]) && consultaPlaneacionEnServidor('Enséñamela', HOY, BORRADOR_NUEVO, [`${PREFIJO_CONFIRMACION_APROBACION}cuentos.`]),
    '6b. Caso real: un borrador ya publicado como documento activo nunca se muestra en lugar de la versión canónica')
  verificar(!consultaPlaneacionEnServidor('Muéstrame la planeación', HOY, BORRADOR_AJUSTE, []) && !consultaPlaneacionEnServidor('Enséñamela', HOY, BORRADOR_NUEVO, []),
    '6c. Ajuste pendiente o borrador nuevo sin guardar: se sigue mostrando en el cliente')
  verificar(!consultaPlaneacionEnServidor('Muéstramelo', HOY, examenActivo, [PUBLICADA]) && !consultaPlaneacionEnServidor('Muéstrame la versión anterior', HOY, VERSION_CONSULTADA, []) && !consultaPlaneacionEnServidor('Cámbiale la sesión 2', HOY, VERSION_CONSULTADA, []),
    '6d. Otro documento activo, una versión anterior o un cambio: sin cambios de comportamiento')
  verificar(['_Versión 2 · guardada el 25 nov 2026, 17:07 · 24 nov – 30 nov 2026_', '_Versión 2 de 2 (vigente) · guardada el 25 nov · x_', '_Versión 1 de 2 · guardada el 24 nov · x_'].every(esVersionGuardadaMostrada) && !esVersionGuardadaMostrada(BORRADOR_AJUSTE)
    && readFileSync(join(__dirname, '..', 'lib', 'planeacion', 'consultaPlaneaciones.ts'), 'utf-8').includes('const pie = `_${etiquetaVersion} · guardada el '),
    '6e. Se reconoce el pie real de una versión guardada (única, vigente o anterior)')

  // ============================================================
  // 7. Consulta contextual sin nombre: servidor (planeacion_activa, sin IA)
  // ============================================================
  const DOCENTE = '11111111-1111-4111-8111-111111111111'
  const CONV = '44444444-4444-4444-8444-444444444444'
  const PL = '55555555-5555-4555-8555-555555555555'
  const bd = (o: { referencia?: boolean; vigente?: number; ajusteBase?: number; publicadaEnOtro?: boolean } = {}) => {
    const t: Record<string, Record<string, unknown>[]> = {
      conversaciones_chat: [{ id: CONV, planeacion_activa: o.referencia === false ? null : { esquema: 'referencia-planeacion-v1', planeacionId: PL, numero: o.vigente ?? 2, opciones: [], ajustes: [{ planeacionId: PL, versionBase: o.ajusteBase ?? 2, grupoId: 'g', huella: huellaBorrador(BORRADOR_AJUSTE), creadoEn: 'x' }] } }],
      planeaciones: [{ id: PL, docente_id: DOCENTE, nombre: NOMBRE, version: o.vigente ?? 2 }],
      planeacion_versiones: o.publicadaEnOtro ? [{ planeacion_id: PL, docente_id: DOCENTE, numero: (o.ajusteBase ?? 2) + 1, borrador_clave: `msg:${CONV}:m1` }] : [],
      mensajes_chat: o.publicadaEnOtro ? [{ id: `${CONV}:m1`, texto: BORRADOR_AJUSTE }] : [],
    }
    const consultas: string[] = []
    const sb = { from: (tabla: string) => {
      consultas.push(tabla)
      const f: [string, unknown][] = []
      const q = { select: () => q, eq: (c: string, v: unknown) => { f.push([c, v]); return q }, maybeSingle: async () => ({ data: (t[tabla] ?? []).find((x) => f.every(([c, v]) => x[c] === v)) ?? null, error: null }) }
      return q
    } } as unknown as SupabaseClient
    return { sb, consultas }
  }
  const h = (...respuestas: string[]) => respuestas.flatMap((r) => [{ role: 'user', content: '…' }, { role: 'assistant', content: r }])
  const resolver = (o: Parameters<typeof bd>[0], historialC: { role: string; content: string }[]) => { const b = bd(o); return resolverConsultaContextual(b.sb, DOCENTE, CONV, historialC).then((r) => ({ r, consultas: b.consultas })) }
  verificar((await resolver({}, h(VERSION_CONSULTADA))).r?.tipo === 'vigente', '7a. Último documento: una versión guardada → la versión vigente de planeacion_activa')
  verificar((await resolver({ vigente: 3, ajusteBase: 2 }, h(BORRADOR_AJUSTE, PUBLICADA))).r?.tipo === 'vigente', '7b. Caso real: borrador ya publicado (confirmado) → la versión vigente, nunca el borrador')
  const pendiente = await resolver({}, h(VERSION_CONSULTADA, BORRADOR_AJUSTE))
  verificar(pendiente.r?.tipo === 'aclaracion' && pendiente.r.texto.includes(`«${NOMBRE}»`) && pendiente.r.texto.includes('la 2') && pendiente.r.texto.includes('«muéstrame la versión vigente»'),
    '7c. Ajuste realmente pendiente (base = vigente): ambigüedad real → aclaración, sin elegir por el docente')
  verificar((await resolver({ vigente: 3, ajusteBase: 2, publicadaEnOtro: true }, h(BORRADOR_AJUSTE))).r?.tipo === 'vigente', '7d. Publicado desde otro dispositivo (sin confirmación aquí): la versión canónica lo sabe → vigente')
  verificar((await resolver({ vigente: 3, ajusteBase: 2 }, h(BORRADOR_AJUSTE))).r?.tipo === 'vigente', '7e. Ajuste con base obsoleta: la versión vigente prevalece')
  verificar((await resolver({}, h(VERSION_CONSULTADA, BORRADOR_NUEVO))).r === null && (await resolver({}, h(VERSION_CONSULTADA, examenActivo))).r === null,
    '7f. Borrador nuevo sin guardar u otro documento (examen) como último documento: no es la planeación guardada (camino de siempre)')
  verificar((await resolver({ referencia: false }, h(VERSION_CONSULTADA))).r === null && (await resolver({}, [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'Hola' }])).r?.tipo === 'vigente',
    '7g. Sin planeacion_activa: nada; con ella y sin documentos en el historial: la referencia persistida')
  verificar(!pendiente.consultas.some((c) => !['conversaciones_chat', 'planeaciones', 'planeacion_versiones', 'mensajes_chat'].includes(c)), '7h. Solo lecturas de referencia y versión canónica (sin escrituras ni IA)')
  const iDetector = ruta.indexOf('detectarConsultaPlaneacion(textoConsulta, sesion.fecha_actual)')
  const iContextual = ruta.indexOf('const contextual = await resolverConsultaContextual(supabaseUser, userId, await conversacionPropia(), historialMensajes)')
  const iClasificacion = ruta.indexOf('const clasificacion = ajusteDelTurno')
  verificar(iDetector > 0 && iContextual > iDetector && iClasificacion > iContextual && ruta.includes("if (contextual?.tipo === 'vigente') consultaPlaneacion = { tipo: 'version', version: 'vigente' }") && ruta.includes("if (contextual?.tipo === 'aclaracion') return respuestaTexto(contextual.texto)"),
    '7i. Ruta: la consulta contextual reutiliza la consulta determinista de versiones, antes del clasificador')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
