// scripts/verificar-turno-durable.ts
//
// Prueba aislada de "ARQUITECTURA DURABLE — Vercel Workflow +
// Supabase turnos_chat": confirma que la generación del Chat IA ya
// no depende de que Safari/iPhone siga conectado.
//
// LÍMITE HONESTO (mismo criterio que las otras 20 suites de esta
// serie): lib/turnosChat.ts, app/workflows/generarTurnoChat.ts y los
// endpoints nuevos requieren una sesión REAL de Supabase (RLS depende
// de auth.uid(), que exige un JWT real de un docente existente) y/o
// una ejecución REAL de Vercel Workflow — ninguna de las dos se puede
// fabricar en un script aislado sin credenciales ni red real, así que
// esta prueba combina:
//   (a) ejecución REAL de todo lo que sí es puro (generarRequestId,
//       el mapeo desdeFila, la forma exacta del payload durable);
//   (b) verificación ESTRUCTURAL de los invariantes de idempotencia/
//       recuperación/errores en el código real (ON CONFLICT, chequeo
//       de estado antes de regenerar, guard de turnoActivoId, etc.);
//   (c) confirmación de que la migración turnos_chat quedó aplicada
//       de verdad contra el proyecto remoto (ver FASE 2 del informe:
//       `npx supabase migration list` — local y remoto coinciden).
// La validación de extremo a extremo (cerrar Safari de verdad,
// esperar minutos, volver) sigue pendiente de un dispositivo real,
// exactamente como el resto del módulo de voz/documentos en este
// proyecto.
// Se ejecuta con `npx tsx scripts/verificar-turno-durable.ts`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// NUNCA se importa lib/asistente/turnoDurableCliente.ts directamente
// aquí: transitivamente construye un cliente real de Supabase al
// cargar el módulo (vía perfilDocente.ts -> supabaseClient.ts),
// exactamente la misma razón por la que ninguna de las otras 20
// suites de esta serie importa un motor/servicio completo — se
// verifica su contenido de forma estructural más abajo en su lugar.

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// Quita líneas de comentario (-- en SQL, // en TS) antes de buscar
// frases prohibidas — mismo criterio usado en toda esta serie de
// pruebas: una explicación como "nunca usa service_role" en un
// comentario no debe contarse como un falso positivo.
function sinComentarios(codigo: string): string {
  return codigo
    .split('\n')
    .filter((l) => !l.trim().startsWith('--') && !l.trim().startsWith('//'))
    .join('\n')
}

const RAIZ = join(__dirname, '..')
const cuerpoMigracion = readFileSync(join(RAIZ, 'supabase/migrations/20260808000000_crear_turnos_chat.sql'), 'utf-8')
const cuerpoTurnosChat = readFileSync(join(RAIZ, 'lib/turnosChat.ts'), 'utf-8')
const cuerpoWorkflow = readFileSync(join(RAIZ, 'app/workflows/generarTurnoChat.ts'), 'utf-8')
const cuerpoChatRoute = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf-8')
const cuerpoTurnoEndpoint = readFileSync(join(RAIZ, 'app/api/chat/turno/[turnId]/route.ts'), 'utf-8')
const cuerpoAsistenteService = readFileSync(join(RAIZ, 'lib/asistente/AsistenteService.ts'), 'utf-8')
const cuerpoTurnoCliente = readFileSync(join(RAIZ, 'lib/asistente/turnoDurableCliente.ts'), 'utf-8')
const cuerpoNextConfig = readFileSync(join(RAIZ, 'next.config.ts'), 'utf-8')

async function main() {
  // ============================================================
  // Esquema y RLS (migración) — 100% aditiva, request_id UNIQUE,
  // estados limitados, RLS por docente, sin service_role.
  // ============================================================
  verificar(cuerpoMigracion.includes('create table if not exists public.turnos_chat'), 'Esquema: create table if not exists (idempotente, nunca DROP/ALTER de tablas existentes)')
  verificar(cuerpoMigracion.includes('request_id text not null unique'), 'Esquema: request_id UNIQUE — protección real de idempotencia a nivel de base de datos')
  verificar(/check\s*\(\s*estado in \('queued', 'generating', 'completed', 'failed'\)\)/.test(cuerpoMigracion), 'Esquema: estado limitado exactamente a queued/generating/completed/failed')
  verificar(cuerpoMigracion.includes('alter table public.turnos_chat enable row level security'), 'RLS: activado sobre turnos_chat')
  verificar(cuerpoMigracion.includes('using (docente_id = auth.uid())'), 'RLS: "solo titular" — docente_id = auth.uid(), mismo patrón que planeaciones')
  {
    const migracionSinComentarios = sinComentarios(cuerpoMigracion)
    verificar(!/for all/i.test(migracionSinComentarios), 'RLS: sin políticas FOR ALL (select/insert/update explícitos, mismo criterio que el resto del proyecto)')
    verificar(!/for delete/i.test(migracionSinComentarios), 'RLS: sin política DELETE — ningún flujo de esta arquitectura borra turnos')
    verificar(!/service_role/i.test(migracionSinComentarios), 'Migración: no usa service_role')
    // El único "drop table" real permitido es el de turnos_chat DENTRO
    // del bloque de rollback documentado (comentario, ya filtrado
    // arriba) — fuera de comentarios, cualquier "drop table"/"drop
    // column"/"alter table" sobre OTRA tabla sería una regresión real.
    verificar(!/\bdrop table\b|\bdrop column\b|\balter table\s+public\.(?!turnos_chat)/i.test(migracionSinComentarios), 'Migración: no modifica ninguna tabla/columna existente (100% aditiva) — fuera del comentario de rollback documentado')
  }

  // ============================================================
  // FASE 3 — Idempotencia real: INSERT ... ON CONFLICT, nunca
  // "SELECT primero, INSERT después" (condición de carrera real ante
  // doble tap / mismo request_id enviado dos veces).
  // ============================================================
  verificar(cuerpoTurnosChat.includes(".insert({ docente_id: docenteId, conversacion_id: conversacionId, request_id: requestId, estado: 'queued' })"), 'Idempotencia: crearOTurnoRecuperarPorRequestId hace INSERT directo (nunca SELECT primero)')
  verificar(cuerpoTurnosChat.includes("!== '23505'"), 'Idempotencia: distingue el error de unique_violation (23505) real de cualquier otro error — un 23505 es RECUPERACIÓN, nunca una falla')
  verificar(!/select.*maybeSingle[\s\S]{0,200}insert\(/i.test(cuerpoTurnosChat), 'Idempotencia: no existe el patrón inseguro "SELECT primero, luego INSERT" en este archivo')

  // ============================================================
  // FASE 5 — Workflow: directivas reales, idempotencia dentro del
  // propio Workflow (nunca regenerar si ya completed), fallo real
  // marca failed con mensaje controlado, reutiliza el 100% de la
  // lógica existente vía llamada interna a /api/chat (nunca la
  // duplica).
  // ============================================================
  verificar(/'use workflow';/.test(cuerpoWorkflow), "Workflow: generarTurnoChat está marcado 'use workflow'")
  verificar((cuerpoWorkflow.match(/'use step';/g) ?? []).length === 2, 'Workflow: exactamente 2 pasos marcados \'use step\' (validar+marcar generating, generar+persistir)')
  verificar(cuerpoWorkflow.includes("if (turno.estado === 'completed') return { yaCompletado: true }"), 'Workflow: el paso de validación NUNCA regenera si el turno ya está completed (reintento de step seguro)')
  verificar(cuerpoWorkflow.includes("if (turnoActual?.estado === 'completed') return"), 'Workflow: el paso de generación TAMBIÉN comprueba completed antes de volver a llamar a la IA (defensa adicional ante reintento tardío)')
  verificar(cuerpoWorkflow.includes('await marcarFallido(auth.supabase, turnoId, mensajeError)'), 'Workflow: un fallo real de la llamada interna marca failed con un mensaje técnico controlado')
  verificar(cuerpoWorkflow.includes("esTurnoInterno: true"), 'Workflow: la llamada a /api/chat se marca esTurnoInterno — reutiliza el 100% de la lógica existente, nunca la duplica')
  verificar(cuerpoWorkflow.includes('procesarMarcadorDeArchivo') && cuerpoWorkflow.includes("from '@/lib/asistente/marcadoresRespuesta'"), 'Workflow: usa las MISMAS funciones puras de extracción de marcadores que ya usa el cliente — nunca una segunda interpretación')
  verificar(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(cuerpoWorkflow), 'Workflow: nunca usa service_role — cada paso se autentica con el access_token real del docente')

  // ============================================================
  // FASE 4 — POST /api/chat: rama nueva y aditiva, nunca se ejecuta
  // sin requestId explícito (voz y cualquier llamador existente
  // quedan exactamente igual), nunca vuelve a iniciar el Workflow
  // para un request_id ya existente.
  // ============================================================
  verificar(cuerpoChatRoute.includes('if (requestId && !esTurnoInterno) {'), 'POST /api/chat: la rama durable solo se activa con requestId explícito — ningún llamador existente (voz, etc.) cambia de comportamiento')
  verificar(cuerpoChatRoute.includes("if (turno.estado === 'queued') {") && cuerpoChatRoute.includes('await start(generarTurnoChat,'), 'POST /api/chat: el Workflow solo se inicia si el turno es NUEVO (estado queued) — un request_id repetido nunca lo vuelve a iniciar')
  verificar((cuerpoChatRoute.match(/await start\(generarTurnoChat,/g) ?? []).length === 1, 'POST /api/chat: exactamente UN punto de arranque del Workflow en todo el archivo')
  verificar(cuerpoChatRoute.includes("esTurnoInterno } = await req.json()"), 'POST /api/chat: esTurnoInterno es un campo real recibido del body, no un valor inventado')

  // ============================================================
  // FASE 7 — Endpoint de consulta: autenticado, nunca devuelve el
  // turno de otro docente, nunca usa service_role.
  // ============================================================
  verificar(cuerpoTurnoEndpoint.includes('autenticarRequestApi(accessToken)'), 'GET /api/chat/turno/[turnId]: exige autenticación real (mismo mecanismo que el resto de la app)')
  verificar(cuerpoTurnoEndpoint.includes('turno.docenteId !== auth.user.id'), 'GET /api/chat/turno/[turnId]: comprobación explícita de que el turno pertenece al docente autenticado')
  verificar(!/service_role|SUPABASE_SERVICE_ROLE_KEY/.test(sinComentarios(cuerpoTurnoEndpoint)), 'GET /api/chat/turno/[turnId]: nunca usa service_role')

  // ============================================================
  // FASE 8/9 — Cliente: recuperación automática, nunca crea una
  // burbuja falsa, nunca reenvía el prompt, máximo 1 respuesta
  // lógica por turno (guard de turnoActivoId).
  // ============================================================
  verificar(cuerpoAsistenteService.includes("window.addEventListener('pageshow'") && cuerpoAsistenteService.includes("window.addEventListener('focus'") && cuerpoAsistenteService.includes("window.addEventListener('online'"), 'Cliente: escucha pageshow/focus/online para recuperación automática')
  verificar(cuerpoAsistenteService.includes('AsistenteService.reanudarTurnoPendienteSiExiste()'), 'Cliente: visibilitychange (al volver visible) dispara la recuperación automática del turno pendiente')
  verificar(cuerpoAsistenteService.includes('if (this.turnoActivoId !== turno.id) return'), 'Cliente: hidratarTurnoCompletado/manejarTurnoFallido comprueban turnoActivoId antes de tocar mensajes — ningún evento tardío produce una segunda burbuja')
  verificar((cuerpoAsistenteService.match(/this\.mensajes = \[\s*\.\.\.this\.mensajes,\s*\{ id: idNuevo, rol: 'asistente'/g) ?? []).length === 1, 'Cliente: exactamente un punto de inserción de la respuesta final hidratada')
  verificar(!/mensaje-usuario.*Continúa|texto:\s*['"]Continúa['"]|texto:\s*['"]Inténtalo otra vez['"]/i.test(cuerpoAsistenteService), 'Cliente: en ningún lugar se inserta un mensaje automático "Continúa"/"Inténtalo otra vez" en nombre del docente')
  verificar(cuerpoAsistenteService.includes('this.reanudarTurnoPendienteSiExiste()') && cuerpoAsistenteService.includes('abrirConversacion(id: string)'), 'Cliente: abrirConversacion() también retoma un turno pendiente de esa conversación (caso "la app se cerró por completo")')

  // ============================================================
  // 8 (test). Doble tap / mismo request_id enviado dos veces —
  // crypto.randomUUID() (la misma primitiva real que usa
  // generarRequestId() en turnoDurableCliente.ts, confirmado por
  // verificación estructural abajo) produce un identificador real y
  // distinto en cada llamada — la protección real contra el doble tap
  // vive en el UNIQUE de la base de datos, nunca en la generación del
  // id en sí.
  // ============================================================
  {
    const id1 = crypto.randomUUID()
    const id2 = crypto.randomUUID()
    verificar(typeof id1 === 'string' && id1.length > 0, 'crypto.randomUUID() produce un identificador real (disponible en Node y en todo navegador con WebRTC)')
    verificar(id1 !== id2, 'Dos llamadas seguidas producen ids distintos — el mismo request_id solo se repite si el CLIENTE decide reutilizarlo a propósito (reintento del mismo turno)')
    verificar(cuerpoTurnoCliente.includes('export function generarRequestId(): string {') && cuerpoTurnoCliente.includes('return crypto.randomUUID()'), 'generarRequestId() en turnoDurableCliente.ts usa exactamente crypto.randomUUID()')
  }

  // ============================================================
  // Alcance V1 declarado — la rama durable se activa exactamente
  // para el caso reportado (texto simple, sin imagen, fuera de voz).
  // ============================================================
  verificar(cuerpoAsistenteService.includes("if (!adjunto && canal !== 'voz') {") && cuerpoAsistenteService.includes('await this.enviarMensajeDurable(limpio)'), 'Cliente: la rama durable se activa exactamente para mensaje de texto simple sin imagen, fuera de voz (alcance V1 declarado)')

  // ============================================================
  // Compatibilidad Vercel Workflow — verificada con build real (ver
  // informe): next.config.ts envuelto con withWorkflow, sin runtime
  // Edge en /api/chat (Node.js, requisito para el Workflow SDK).
  // ============================================================
  verificar(cuerpoNextConfig.includes("withWorkflow(nextConfig)") && cuerpoNextConfig.includes("from \"workflow/next\""), 'next.config.ts está envuelto con withWorkflow — verificado también con `npm run build` real ("Compiled workflows... 1 workflow")')
  verificar(!cuerpoChatRoute.includes("export const runtime = 'edge'"), '/api/chat sigue en runtime Node.js (nunca Edge) — requisito de Vercel Workflow y de toda la lógica existente')

  console.log('')
  if (fallos > 0) {
    console.error(`${fallos} prueba(s) fallaron.`)
    process.exit(1)
  } else {
    console.log('Todas las pruebas pasaron.')
  }
}

main()
