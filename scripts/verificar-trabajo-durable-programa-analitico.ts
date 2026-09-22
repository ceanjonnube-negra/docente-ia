// scripts/verificar-trabajo-durable-programa-analitico.ts
//
// PA-5F — ejecución durable/recuperable de la generación inicial del
// Programa Analítico (imagen adjunta + gestionar + sin borrador
// pendiente aún, ver auditoría PA-5E: ~83s de visual+generación en un
// solo request bloqueante, exactamente el patrón que Safari/iPhone en
// segundo plano interrumpe). Reutiliza el 100% de la infraestructura
// ya probada en verificar-trabajo-documento-asincrono.ts (misma tabla
// trabajos_documento, mismo endpoint GET de estado, mismo
// localStorage+polling+listeners de reconexión) — nunca la duplica,
// nunca reclasifica con Nivel0 ni gasta una segunda llamada IA por
// esto (la llamada real al trabajo vive DENTRO del mismo proceso vía
// after(), nunca un fetch interno a /api/chat).
//
// Mismo criterio que esa prueba: verificación ESTRUCTURAL sobre el
// código real (un trabajo real de extremo a extremo requiere Claude +
// Supabase reales, no se puede fabricar en un script aislado) — la
// integración funcional (deltas/roster/PDA/etc.) ya está cubierta por
// verificar-manejar-turno-programa-analitico.ts.
//
// Se ejecuta con
// `npx tsx scripts/verificar-trabajo-durable-programa-analitico.ts`.

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

const RAIZ = join(__dirname, '..')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoAsistenteService = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')
const cuerpoMotorTexto = readFileSync(join(RAIZ, 'lib/asistente/motores/motorTextoClaude.ts'), 'utf-8')
const cuerpoTrabajosDocumento = readFileSync(join(RAIZ, 'lib/trabajosDocumento.ts'), 'utf-8')
const cuerpoTrabajoCliente = readFileSync(join(RAIZ, 'lib/asistente/trabajoDocumentoCliente.ts'), 'utf-8')
const cuerpoTipos = readFileSync(join(RAIZ, 'lib/asistente/tipos.ts'), 'utf-8')

async function main() {
  // ============================================================
  // CASO I / punto de enrutamiento — la condición vive DENTRO del
  // guard de programa_analitico (nunca "hay imagen" de forma
  // genérica) y exige gestionar + adjunto real + sin pendiente.
  // ============================================================
  {
    // PA-5G — la condición usa accionProgramaAnaliticoEfectiva (Nivel 0
    // real, o 'gestionar' cuando la red de seguridad por estado
    // canónico lo activó) en vez del campo crudo de Nivel 0 — mismo
    // comportamiento exacto para el camino que Nivel 0 ya clasificaba
    // bien (ver verificar-red-seguridad-estado-programa-analitico.ts,
    // CASO-H2), nunca "hay imagen" de forma genérica.
    const idxGuardPa = cuerpoChatRoute.indexOf("clasificacion.intencion_principal === 'programa_analitico'")
    const idxRuteo = cuerpoChatRoute.indexOf("accionProgramaAnaliticoEfectiva === 'gestionar' && adjuntoProgramaAnalitico && sesion.grupo_activo_id && userId")
    verificar(idxGuardPa > -1 && idxRuteo > idxGuardPa && idxRuteo - idxGuardPa < 4000, 'I. la condición de enrutamiento durable vive DENTRO del guard de programa_analitico — ningún otro intent puede activarla')
    verificar(
      cuerpoChatRoute.includes("if (accionProgramaAnaliticoEfectiva === 'gestionar' && adjuntoProgramaAnalitico && sesion.grupo_activo_id && userId) {"),
      'I2. exige accion efectiva=gestionar (nunca confirmar/consultar) + adjunto REAL de este turno + grupo activo + usuario autenticado — nunca "imagen" de forma genérica'
    )
  }

  // ============================================================
  // Nunca duplica Nivel0 ni gasta otra llamada IA — la clasificación
  // ya corrió una vez arriba; el trabajo real llama DIRECTO a
  // manejarTurnoProgramaAnalitico (nunca un fetch interno a /api/chat,
  // a diferencia de trabajo-documento/route.ts, que si reclasificaría).
  // ============================================================
  {
    const idxAfter = cuerpoChatRoute.indexOf('after(async () => {')
    const idxFinAfter = cuerpoChatRoute.indexOf('console.log(`[PROGRAMA_ANALITICO] requestId=${requestIdPa} grupoId=${sesion.grupo_activo_id} accion=gestionar modo=trabajo_durable')
    const bloqueAfterPa = idxAfter > -1 && idxFinAfter > idxAfter ? cuerpoChatRoute.slice(idxAfter, idxFinAfter) : ''
    verificar(bloqueAfterPa.includes('await manejarTurnoProgramaAnalitico('), 'la generación real dentro de after() llama DIRECTO a manejarTurnoProgramaAnalitico (mismo proceso, sin fetch, sin reclasificar)')
    verificar(!bloqueAfterPa.includes("fetch(new URL('/api/chat'"), 'NUNCA hace un fetch interno a /api/chat — eso reclasificaría con Nivel0 y gastaría una segunda llamada IA real, exactamente lo prohibido')
    verificar(!bloqueAfterPa.includes('clasificarNivel0('), 'el bloque durable nunca vuelve a llamar clasificarNivel0 — la clasificación de este turno ya corrió una sola vez, arriba, antes de decidir el enrutamiento')
  }

  // ============================================================
  // CASO B — idempotencia real del trabajo: mismo request_id
  // (mensajeUsuarioIdSolicitado, señal determinista YA disponible,
  // nunca un id nuevo inventado del lado cliente) nunca crea un
  // segundo trabajo ni repite la generación.
  // ============================================================
  {
    verificar(cuerpoChatRoute.includes('const requestIdTrabajoPa = mensajeUsuarioIdSolicitado || requestIdPa'), 'B. reutiliza mensajeUsuarioIdSolicitado (ya generado SIEMPRE por AsistenteService antes de enviar) como request_id — nunca inventa un identificador nuevo')
    verificar(cuerpoChatRoute.includes('crearOTrabajoRecuperarPorRequestId(') && cuerpoChatRoute.includes('trabajoPaYaExistia'), 'B2. usa crearOTrabajoRecuperarPorRequestId (idempotencia real por UNIQUE en DB, ver verificar-trabajo-documento-asincrono.ts) — mismo mecanismo ya probado, no uno nuevo')
    verificar(cuerpoChatRoute.includes('if (!trabajoPaYaExistia) {'), 'B3. si el trabajo YA existía (reenvío/doble tap), NUNCA se vuelve a llamar after() — la generación no se repite')
  }

  // ============================================================
  // Header de respuesta — mismo patrón EXACTO que
  // HEADER_DECISION_ORQUESTADOR (headers, nunca el body, para
  // transportar una decisión fuera de banda) — body vacío a propósito.
  // ============================================================
  {
    verificar(cuerpoTrabajosDocumento.includes("export const HEADER_TRABAJO_DURABLE_ID = "), 'HEADER_TRABAJO_DURABLE_ID está exportado desde lib/trabajosDocumento.ts (infraestructura ya general, no exclusiva de documentos)')
    verificar(cuerpoChatRoute.includes('[HEADER_TRABAJO_DURABLE_ID]: trabajoPa.id') && cuerpoChatRoute.includes('start(controller) {\n                    controller.close()'), 'la respuesta inmediata lleva el header con el trabajoId y un body vacío (mismo patrón que el short-circuit del orquestador)')
  }

  // ============================================================
  // CASO F (persistencia server-owned) + idempotencia del MENSAJE
  // (Fase 5) — mismo patrón EXACTO ya aprobado para planeación
  // (assistantMessageIdValidado + upsert por id + marcador
  // [[MENSAJE_ASISTENTE_PERSISTIDO:...]]).
  // ============================================================
  {
    verificar(cuerpoChatRoute.includes('assistantMessageIdParaTrabajoPa') && cuerpoChatRoute.includes(".from('mensajes_chat').upsert(filaMensajeAsistentePa, { onConflict: 'id' })"), 'el trabajo escribe el mensaje final DIRECTO en mensajes_chat (upsert por id — idempotente, mismo criterio que guardarMensajeRemoto/persistencia de planeación)')
    verificar(cuerpoChatRoute.includes('MENSAJE_ASISTENTE_PERSISTIDO:'), 'embebe el mismo marcador [[MENSAJE_ASISTENTE_PERSISTIDO:...]] ya reconocido por el cliente — evita el doble guardado')
    verificar(cuerpoChatRoute.includes('await marcarCompletado(supabaseUser, trabajoPaId,'), 'siempre marca el trabajo completado con el resultado final (éxito)')
    verificar(cuerpoChatRoute.includes('await marcarFallido(supabaseUser, trabajoPaId, mensajeErrorPa)'), 'un fallo real durante la generación se marca fallido con el error, nunca se pierde en silencio')
  }

  // ============================================================
  // Cliente — motorTextoClaude.ts lee el header, suprime respuesta-
  // parcial/guardarEnHistorial (mismo criterio que esShortCircuitOrquestador),
  // y transporta trabajoProgramaAnaliticoId en el evento final.
  // ============================================================
  {
    verificar(cuerpoMotorTexto.includes("res.headers.get(HEADER_TRABAJO_DURABLE_ID)"), 'motorTextoClaude.ts lee el nuevo header de la respuesta')
    verificar(cuerpoMotorTexto.includes('esShortCircuitOrquestador || Boolean(trabajoProgramaAnaliticoId)'), 'combina el mismo criterio de supresión que ya usa esShortCircuitOrquestador — nunca una burbuja parcial vacía para este turno')
    verificar(cuerpoMotorTexto.includes('trabajoProgramaAnaliticoId,') && cuerpoMotorTexto.includes("tipo: 'respuesta-final',"), 'el evento respuesta-final transporta trabajoProgramaAnaliticoId al resto de la aplicación')
    verificar(cuerpoTipos.includes('trabajoProgramaAnaliticoId?: string'), 'el tipo EventoMotor declara el campo (contrato explícito, no un any suelto)')
  }

  // ============================================================
  // CASO A/D/E/G — AsistenteService intercepta ANTES que cualquier
  // otra lógica de respuesta-final (mismo criterio que
  // shortCircuitOrquestador), arranca su PROPIO polling/estado
  // (aislado del de documentos), e hidrata el mensaje UNA sola vez.
  // ============================================================
  {
    const idxCaseRespuestaFinal = cuerpoAsistenteService.indexOf("case 'respuesta-final': {")
    const idxInterceptPa = cuerpoAsistenteService.indexOf('if (evento.trabajoProgramaAnaliticoId) {')
    const idxInterceptShortCircuit = cuerpoAsistenteService.indexOf('if (evento.shortCircuitOrquestador && evento.decisionOrquestador) {')
    verificar(
      idxCaseRespuestaFinal > -1 && idxInterceptPa > idxCaseRespuestaFinal && idxInterceptPa < idxInterceptShortCircuit,
      'A. la intercepción de trabajoProgramaAnaliticoId ocurre ANTES que cualquier otra rama de respuesta-final (incluida shortCircuitOrquestador) — nunca crea/persiste una burbuja para este turno'
    )
    verificar(cuerpoAsistenteService.includes('this.iniciarSeguimientoTrabajoProgramaAnalitico(evento.trabajoProgramaAnaliticoId)'), 'A2. arranca el seguimiento real del trabajo')
    verificar(
      cuerpoAsistenteService.includes('private trabajoProgramaAnaliticoActivoId: string | null = null') && cuerpoAsistenteService.includes('private pollingTrabajoPaTimer: ReturnType<typeof setTimeout> | null = null'),
      'estado PROPIO y AISLADO (nunca comparte trabajoDocumentoActivoId/pollingTrabajoTimer con el de documentos)'
    )
    verificar(cuerpoAsistenteService.includes("guardarTrabajoActivo({ trabajoId, requestId: trabajoId, conversacionId: this.conversacionActivaId }, CLAVE_TRABAJO_PA_ACTIVO)"), 'usa una clave de localStorage SEPARADA (CLAVE_TRABAJO_PA_ACTIVO) — nunca pisa el puntero de un trabajo de documento activo')
    verificar(
      cuerpoAsistenteService.includes('if (this.trabajoProgramaAnaliticoActivoId !== trabajoId) return') || cuerpoAsistenteService.includes('if (this.trabajoProgramaAnaliticoActivoId !== trabajo.id) return'),
      'D. el polling comprueba identidad del trabajo antes de tocar cualquier estado — un tick tardío tras hidratar (o tras cambiar de trabajo) nunca hace nada (0 IA, ningún efecto extra)'
    )
    verificar(cuerpoAsistenteService.includes("if (trabajo.estado === 'completado') { this.hidratarTrabajoProgramaAnaliticoCompletado(trabajo); return }"), 'E. trabajo completado → hidratación inmediata en el siguiente tick')
    verificar(cuerpoAsistenteService.includes("if (trabajo.estado === 'fallido') { this.manejarTrabajoProgramaAnaliticoFallido(trabajo); return }"), 'F. trabajo fallido → error recuperable correcto (nunca "Error al conectar con la IA" genérico)')
  }

  // ============================================================
  // CASO C — idempotencia de la HIDRATACIÓN del mensaje: el guard de
  // identidad de arriba (trabajoProgramaAnaliticoActivoId !== trabajo.id)
  // es lo único que hace falta — hidratarTrabajoProgramaAnaliticoCompletado
  // pone trabajoProgramaAnaliticoActivoId=null como PRIMERA acción, así
  // que un segundo evento focus/pageshow que dispare otro tick (o
  // reanudarTrabajoProgramaAnaliticoPendienteSiExiste) encuentra el
  // guard ya cerrado — nunca hidrata dos veces. Además, el marcador
  // MENSAJE_ASISTENTE_PERSISTIDO evita el doble guardado remoto.
  // ============================================================
  {
    const inicioHidratar = cuerpoAsistenteService.indexOf('private hidratarTrabajoProgramaAnaliticoCompletado(trabajo: EstadoTrabajoConsultado) {')
    const finHidratar = cuerpoAsistenteService.indexOf('// Falla REAL del backend (estado=fallido')
    const bloqueHidratar = inicioHidratar > -1 && finHidratar > inicioHidratar ? cuerpoAsistenteService.slice(inicioHidratar, finHidratar) : ''
    verificar(bloqueHidratar.startsWith('private hidratarTrabajoProgramaAnaliticoCompletado(trabajo: EstadoTrabajoConsultado) {\n    if (this.trabajoProgramaAnaliticoActivoId !== trabajo.id) return\n    this.trabajoProgramaAnaliticoActivoId = null'), 'C. trabajoProgramaAnaliticoActivoId se pone en null como PRIMERA acción tras el guard — un segundo tick/evento nunca vuelve a entrar')
    verificar(bloqueHidratar.includes('MENSAJE_ASISTENTE_PERSISTIDO'), 'C2. reconoce el marcador server-side — si el servidor ya guardó el mensaje, el cliente NUNCA lo vuelve a persistir (mismo criterio ya usado por el camino síncrono normal)')
    verificar(bloqueHidratar.includes('if (assistantMessageIdPersistidoServer && assistantMessageIdPersistidoServer === idFinal) return'), 'C3. comparación EXACTA por id (nunca un booleano global) antes de omitir la persistencia propia')
  }

  // ============================================================
  // G/H — listeners de reconexión y recuperación al abrir conversación,
  // mismo patrón EXACTO que reanudarTrabajoDocumentoPendienteSiExiste.
  // ============================================================
  {
    verificar(cuerpoAsistenteService.includes('reanudarTrabajoProgramaAnaliticoPendienteSiExiste()'), 'existe el método de recuperación automática')
    verificar(cuerpoAsistenteService.includes('AsistenteService.reanudarTrabajoProgramaAnaliticoPendienteSiExiste()'), 'está enganchado a los listeners visibilitychange/pageshow/focus/online (mismos 4 eventos que ya cubre el de documentos)')
    verificar(cuerpoAsistenteService.includes('this.reanudarTrabajoDocumentoPendienteSiExiste()\n    // PA-5F — mismo criterio, trabajo separado.\n    this.reanudarTrabajoProgramaAnaliticoPendienteSiExiste()'), 'abrirConversacion() también retoma un trabajo de Programa Analítico pendiente de una sesión anterior (app cerrada por completo)')
    verificar(cuerpoAsistenteService.includes('guardado.conversacionId !== this.conversacionActivaId) return'), 'nunca hidrata un trabajo de OTRA conversación activa por accidente (mismo guard que el de documentos)')
  }

  // ============================================================
  // Costo — 0 llamadas IA en el polling/recuperación, polling
  // reutilizado sin modificación peligrosa (mismo intervalo 3000ms).
  // ============================================================
  {
    const bloquePollingPa = cuerpoAsistenteService.slice(cuerpoAsistenteService.indexOf('private iniciarPollingTrabajoPa('), cuerpoAsistenteService.indexOf('private hidratarTrabajoProgramaAnaliticoCompletado'))
    verificar(!/anthropic|clasificarNivel0|messages\.create|messages\.stream/i.test(bloquePollingPa), 'el polling nunca llama a Anthropic/Nivel0 — solo GET de estado (0 IA)')
    verificar(cuerpoAsistenteService.includes('private iniciarPollingTrabajoPa(trabajoId: string, intervaloMs = 3000)'), 'mismo intervalo (3000ms) que el polling ya probado de documentos — nada agresivo, nada nuevo')
    verificar(cuerpoTrabajoCliente.includes('export async function consultarTrabajo('), 'reutiliza consultarTrabajo tal cual (GET genérico ya probado) — no se duplica ni se reimplementa')
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
