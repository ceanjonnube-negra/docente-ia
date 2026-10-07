// lib/listaOficial/aplicacionFirmada.ts
//
// V1-D2A — contrato HMAC SEPARADO para la aplicación real de cambios de
// lista oficial. Deliberadamente DISTINTO de PayloadPropuestaListaOficial/
// propuestaFirmada.ts (el sobre histórico read-only que ya usa Chat IA,
// ver app/api/chat/route.ts) — ver decisión arquitectónica aprobada
// "V1-D2A, sección 11, opción B": un sobre de aplicación exige
// estructuralmente docenteId + conversacionId + grupoId + generadoEn +
// rosterFingerprint + al menos 1 operación ya resuelta — nunca
// opcionales, nunca ambiguos con el sobre histórico. Fusionar ambos
// contratos en un solo tipo habría obligado a volver opcionales campos
// que aquí son obligatorios, con el riesgo real de que una propuesta
// read-only terminara siendo aceptada por una futura ruta de escritura
// — exactamente lo que este archivo evita por construcción (ver prueba
// "ningún contrato de aplicación acepta la forma histórica por
// accidente" en scripts/verificar-aplicacion-firmada.ts).
//
// MÓDULO SERVER-ONLY: usa node:crypto, nunca debe importarse desde
// código que corre en el navegador. A diferencia de propuestaFirmada.ts,
// sus tipos NO se exponen en lib/asistente/tipos.ts — ningún consumidor
// cliente existe todavía para este contrato (ver diseño aprobado,
// sección 14: no agregar código muerto al navegador en esta fase).
//
// Esta fase (V1-D2A) SOLO define y prueba el contrato firmado. NUNCA
// valida aquí auth.uid(), ownership real contra Supabase, estado actual
// de BD, ni aplica nada — eso es responsabilidad exclusiva de una fase
// posterior (el futuro endpoint/RPC de aplicación), que es quien de
// verdad puede autorizar una escritura real.

import { createHmac, timingSafeEqual } from 'node:crypto'

// ============================================================
// Tipos — unión discriminada, nunca una estructura permisiva con
// propiedades opcionales por variante (ver diseño aprobado, sección 4).
// Cada variante corresponde EXACTAMENTE a una de las 3 categorías de
// PlanDeActualizacionLista que de verdad pueden escribirse — ver
// lib/listaOficial/planActualizacionLista.ts. SIN_CAMBIOS nunca
// necesita firmarse (0 escritura); REQUIERE_CONFIRMACION y
// CONFLICTO_BLOQUEANTE son estructuralmente IRREPRESENTABLES aquí: no
// existe ningún valor de `tipo` para ellos en esta unión, así que
// TypeScript rechaza en tiempo de compilación cualquier intento de
// construir uno (ver prueba de tipo en el script de verificación).
// ============================================================

// Único campo soportado hoy (mismo alcance real que
// reparar_curp_desde_lista_oficial y que CampoActualizablePlanLista en
// planActualizacionLista.ts, ver diseño aprobado sección 5) —
// deliberadamente NO se amplía a nombre/sexo/fecha_nacimiento en esta
// fase, aunque correcciones_alumno ya los soportaría como valor de su
// columna `campo` genérica: primero se cierra el único flujo ya
// construido y probado end-to-end.
export type CampoAplicableListaOficial = 'curp'

export type OperacionActualizarDatoAplicable = {
  tipo: 'actualizar_dato'
  alumnoId: string
  campo: CampoAplicableListaOficial
  // string | null — NUNCA normalizado antes de firmar (ver diseño
  // aprobado sección 6): el CAS futuro (reparar_curp_desde_lista_oficial
  // ya usa IS NOT DISTINCT FROM) debe comparar contra el valor RAW
  // exacto que el servidor observó en alumnos.curp al construir esta
  // operación, nunca contra una copia en mayúsculas/sin espacios —
  // normalizar aquí rompería esa semántica para la fase de aplicación.
  valorActual: string | null
  valorPropuesto: string
}

// Campos confirmados contra V1-A real (lib/listaOficial/
// analisisListaOficial.ts, RegistroExtraidoListaOficial) antes de
// definir esta variante — ver diseño aprobado sección 7: la extracción
// hoy SOLO produce nombreLeido/curpLeida con certeza razonable; no
// existe ningún campo de sexo ni fecha de nacimiento en todo el
// pipeline V1-A/V1-B, así que agregarlos aquí habría sido inventar un
// dato que ninguna fase anterior puede respaldar. `nombre` es
// obligatorio y nunca null: una alta sin nombre legible no es una
// operación accionable con sentido (V1-B puede producir NUEVO_POSIBLE
// incluso con nombreLeido null — esa fila nunca debe convertirse en
// una operación 'alta' firmable; esa decisión corresponde a la fase
// que construya estas operaciones a partir del plan, no a este
// contrato). `curp` sí puede ser null — V1-A soporta explícitamente
// "CURP no legible/ausente" como una lectura real y válida.
// Deliberadamente SIN alumnoId/inscripcionId (ver diseño aprobado
// sección 7): una alta NUNCA reutiliza ni fusiona historial.
export type OperacionAltaAplicable = {
  tipo: 'alta'
  nombre: string
  curp: string | null
}

// Solo los IDs ya resueltos — nunca nombre, posición/numero_lista, ni
// ningún dato histórico (ver diseño aprobado sección 8):
// dar_de_baja_inscripcion ya autoriza y ejecuta la baja real únicamente
// con p_inscripcion_id; alumnoId viaja aquí solo como defensa en
// profundidad para que la fase de aplicación pueda reconfirmar que esa
// inscripción sigue perteneciendo al alumno esperado, nunca porque la
// RPC real lo necesite como argumento.
export type OperacionBajaAplicable = {
  tipo: 'baja'
  alumnoId: string
  inscripcionId: string
}

// Unión discriminada real — ver cabecera del archivo.
export type OperacionAplicableListaOficial = OperacionActualizarDatoAplicable | OperacionAltaAplicable | OperacionBajaAplicable

// Exactamente lo que la firma HMAC protege — ver
// construirPayloadCanonicoAplicacion más abajo. A diferencia de
// PayloadPropuestaListaOficial (donde grupoId/rosterFingerprint son
// opcionales por retrocompatibilidad con el sobre histórico read-only),
// aquí TODOS los campos son requeridos: este es un contrato distinto,
// exclusivo de aplicación, que nunca necesita aceptar una forma
// antigua — ver decisión arquitectónica, sección 11, opción B.
export type PayloadAplicacionListaOficial = {
  docenteId: string
  conversacionId: string
  grupoId: string
  generadoEn: string
  rosterFingerprint: string
  operaciones: OperacionAplicableListaOficial[]
}

export type SobreAplicacionListaOficial = {
  payload: PayloadAplicacionListaOficial
  firma: string
}

// ============================================================
// Validación de forma — whitelist EXACTA en cada nivel (sobre, payload,
// y cada variante de operación). A diferencia de propuestaFirmada.ts,
// este contrato no necesita admitir ninguna clave opcional: toda clave
// listada es requerida y cualquier clave fuera de la lista rechaza el
// objeto completo — ver diseño aprobado sección 12.
// ============================================================

function tieneExactamenteLasClaves(obj: Record<string, unknown>, clavesPermitidas: readonly string[]): boolean {
  const claves = Object.keys(obj)
  if (claves.length !== clavesPermitidas.length) return false
  return clavesPermitidas.every((clave) => Object.prototype.hasOwnProperty.call(obj, clave))
}

const CLAVES_OPERACION_ACTUALIZAR_DATO = ['tipo', 'alumnoId', 'campo', 'valorActual', 'valorPropuesto'] as const
const CLAVES_OPERACION_ALTA = ['tipo', 'nombre', 'curp'] as const
const CLAVES_OPERACION_BAJA = ['tipo', 'alumnoId', 'inscripcionId'] as const
const CLAVES_PAYLOAD_APLICACION = ['docenteId', 'conversacionId', 'grupoId', 'generadoEn', 'rosterFingerprint', 'operaciones'] as const
const CLAVES_SOBRE_APLICACION = ['payload', 'firma'] as const

// Misma forma que CAMPOS_ACCIONABLES_VALIDOS en propuestaFirmada.ts —
// patrón ya existente reutilizado, no una lista nueva inventada.
const CAMPOS_APLICABLES_VALIDOS: CampoAplicableListaOficial[] = ['curp']

// Validación estructural pura por operación — exportada para que una
// fase posterior (la que construya estas operaciones a partir de
// PlanDeActualizacionLista) pueda reusarla antes de firmar, igual que
// esCambioListaOficialValido en propuestaFirmada.ts.
export function esOperacionAplicableListaOficialValida(valor: unknown): valor is OperacionAplicableListaOficial {
  if (typeof valor !== 'object' || valor === null) return false
  const o = valor as Record<string, unknown>
  if (typeof o.tipo !== 'string') return false

  if (o.tipo === 'actualizar_dato') {
    if (!tieneExactamenteLasClaves(o, CLAVES_OPERACION_ACTUALIZAR_DATO)) return false
    return (
      typeof o.alumnoId === 'string' && o.alumnoId.trim().length > 0 &&
      typeof o.campo === 'string' && (CAMPOS_APLICABLES_VALIDOS as string[]).includes(o.campo) &&
      // trim() SOLO para validar que exista contenido real — el valor
      // en sí (o.valorActual) nunca se reasigna ni se recorta aquí; el
      // RAW exacto sigue viajando intacto hacia canonicalizarOperacion.
      (o.valorActual === null || (typeof o.valorActual === 'string' && o.valorActual.trim().length > 0)) &&
      typeof o.valorPropuesto === 'string' && o.valorPropuesto.trim().length > 0
    )
  }

  if (o.tipo === 'alta') {
    if (!tieneExactamenteLasClaves(o, CLAVES_OPERACION_ALTA)) return false
    return (
      typeof o.nombre === 'string' && o.nombre.trim().length > 0 &&
      (o.curp === null || (typeof o.curp === 'string' && o.curp.trim().length > 0))
    )
  }

  if (o.tipo === 'baja') {
    if (!tieneExactamenteLasClaves(o, CLAVES_OPERACION_BAJA)) return false
    return (
      typeof o.alumnoId === 'string' && o.alumnoId.trim().length > 0 &&
      typeof o.inscripcionId === 'string' && o.inscripcionId.trim().length > 0
    )
  }

  // Cualquier otro valor de `tipo` — incluidos 'requiere_confirmacion'
  // o 'conflicto' si algún llamador en runtime intentara construirlos
  // a mano sin pasar por el tipo (bypasseando TypeScript con `as`) — se
  // rechaza aquí explícitamente, nunca se asume válido por omisión.
  return false
}

export function esPayloadAplicacionListaOficialValido(valor: unknown): valor is PayloadAplicacionListaOficial {
  if (typeof valor !== 'object' || valor === null) return false
  const o = valor as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_PAYLOAD_APLICACION)) return false
  return (
    typeof o.docenteId === 'string' && o.docenteId.trim().length > 0 &&
    typeof o.conversacionId === 'string' && o.conversacionId.trim().length > 0 &&
    typeof o.grupoId === 'string' && o.grupoId.trim().length > 0 &&
    typeof o.generadoEn === 'string' && o.generadoEn.trim().length > 0 &&
    typeof o.rosterFingerprint === 'string' && o.rosterFingerprint.trim().length > 0 &&
    // Un lote de aplicación vacío no tiene ningún sentido — mismo
    // criterio ya usado en esPayloadPropuestaListaOficialValido
    // (propuesta=[] tampoco es válida ahí).
    Array.isArray(o.operaciones) && o.operaciones.length >= 1 && o.operaciones.every(esOperacionAplicableListaOficialValida)
  )
}

// ============================================================
// Canonicalización explícita — NUNCA JSON.stringify(objetoClienteDirectamente)
// (ver diseño aprobado sección 13): se reconstruye un objeto nuevo,
// campo por campo y variante por variante, en un orden de claves fijo,
// descartando cualquier propiedad que no pertenezca al contrato —
// defensa en profundidad, nunca se confía en que el validador de forma
// siempre se ejecutó antes de canonicalizar.
// ============================================================

function canonicalizarOperacion(op: OperacionAplicableListaOficial): OperacionAplicableListaOficial {
  if (op.tipo === 'actualizar_dato') {
    return { tipo: 'actualizar_dato', alumnoId: op.alumnoId, campo: op.campo, valorActual: op.valorActual, valorPropuesto: op.valorPropuesto }
  }
  if (op.tipo === 'alta') {
    return { tipo: 'alta', nombre: op.nombre, curp: op.curp }
  }
  return { tipo: 'baja', alumnoId: op.alumnoId, inscripcionId: op.inscripcionId }
}

function construirPayloadCanonicoAplicacion(payload: PayloadAplicacionListaOficial): PayloadAplicacionListaOficial {
  return {
    docenteId: payload.docenteId,
    conversacionId: payload.conversacionId,
    grupoId: payload.grupoId,
    generadoEn: payload.generadoEn,
    rosterFingerprint: payload.rosterFingerprint,
    operaciones: payload.operaciones.map(canonicalizarOperacion),
  }
}

function canonicalizarAplicacion(payload: PayloadAplicacionListaOficial): string {
  return JSON.stringify(construirPayloadCanonicoAplicacion(payload))
}

// ============================================================
// Domain separation — ver auditoría final V1-D2A, sección 3: este
// contrato reutiliza el MISMO secreto que propuestaFirmada.ts (mismo
// dominio de confianza), así que la cadena que de verdad entra al HMAC
// debe distinguirse inequívocamente de la del contrato histórico —
// nunca depender SOLO de que las formas de payload hoy tengan un
// número distinto de claves. Constante fija, versionada, nunca
// derivada del cliente ni de ningún valor no determinista (sin
// timestamp, sin nonce): la MISMA cadena de dominio debe producir la
// MISMA firma para el MISMO payload, siempre. Server-side únicamente —
// nunca viaja en el sobre ni se recibe de ningún caller.
// ============================================================

const DOMINIO_HMAC_APLICACION_LISTA_OFICIAL = 'DOCENTE_IA:LISTA_OFICIAL:APLICACION:V1'

// Separador "\n" deliberado (nunca una simple concatenación sin
// separador): sin él, un payload canónico que por coincidencia
// empezara con los mismos caracteres que el dominio podría, en teoría,
// desplazar la frontera entre ambas partes de la cadena. Un salto de
// línea no puede aparecer dentro de JSON.stringify(...) de un objeto
// con valores string (JSON escapa cualquier \n real contenido en un
// valor como \\n), así que esta posición siempre es inequívoca.
function cadenaParaFirmarAplicacion(payload: PayloadAplicacionListaOficial): string {
  return `${DOMINIO_HMAC_APLICACION_LISTA_OFICIAL}\n${canonicalizarAplicacion(payload)}`
}

// ============================================================
// Secreto — reutiliza la MISMA variable de entorno ya usada por
// propuestaFirmada.ts (LISTA_OFICIAL_HMAC_SECRET_KEY): mismo dominio de
// confianza (servidor de Docente IA, familia "lista oficial"); no se
// introduce un segundo secreto solo para distinguir contratos que ya
// se distinguen por su propia forma de payload (mínima infraestructura,
// ver diseño aprobado).
// ============================================================

const LONGITUD_MINIMA_SECRETO = 16

function leerSecretoServerOnly(): string | null {
  const valor = process.env.LISTA_OFICIAL_HMAC_SECRET_KEY
  return typeof valor === 'string' && valor.length >= LONGITUD_MINIMA_SECRETO ? valor : null
}

// --- Núcleo testable — recibe el secreto explícito, nunca lee
// process.env por sí mismo. Mismo patrón exacto que
// firmarConSecreto/verificarConSecreto en propuestaFirmada.ts.

export function firmarAplicacionConSecreto(payload: PayloadAplicacionListaOficial, secreto: string): SobreAplicacionListaOficial {
  if (!esPayloadAplicacionListaOficialValido(payload)) {
    throw new Error('Payload de aplicación de lista oficial inválido — no se firma.')
  }
  const payloadCanonico = construirPayloadCanonicoAplicacion(payload)
  const firma = createHmac('sha256', secreto).update(cadenaParaFirmarAplicacion(payloadCanonico)).digest('hex')
  return { payload: payloadCanonico, firma }
}

export function verificarAplicacionConSecreto(sobre: unknown, secreto: string): boolean {
  if (typeof sobre !== 'object' || sobre === null) return false
  const o = sobre as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_SOBRE_APLICACION)) return false
  if (typeof o.firma !== 'string' || o.firma.length === 0) return false
  if (!esPayloadAplicacionListaOficialValido(o.payload)) return false

  const firmaEsperadaHex = createHmac('sha256', secreto).update(cadenaParaFirmarAplicacion(o.payload)).digest('hex')

  let bufRecibido: Buffer
  let bufEsperado: Buffer
  try {
    bufRecibido = Buffer.from(o.firma, 'hex')
    bufEsperado = Buffer.from(firmaEsperadaHex, 'hex')
  } catch {
    return false
  }
  if (bufRecibido.length !== bufEsperado.length) return false
  try {
    return timingSafeEqual(bufRecibido, bufEsperado)
  } catch {
    return false
  }
}

// --- API de producción — únicas funciones que una futura fase de
// aplicación debe llamar. Fail-closed real: sin secreto real, firmar
// lanza (nunca genera una firma vacía/falsa) y verificar devuelve false
// (nunca "válido por defecto"). El secreto nunca se loguea ni se
// incluye en ningún error.

export function firmarAplicacionListaOficial(payload: PayloadAplicacionListaOficial): SobreAplicacionListaOficial {
  const secreto = leerSecretoServerOnly()
  if (!secreto) {
    throw new Error('LISTA_OFICIAL_HMAC_SECRET_KEY ausente o inválida — no se firma sin secreto real (fail-closed).')
  }
  return firmarAplicacionConSecreto(payload, secreto)
}

export function verificarAplicacionListaOficialFirmada(sobre: unknown): boolean {
  const secreto = leerSecretoServerOnly()
  if (!secreto) return false
  return verificarAplicacionConSecreto(sobre, secreto)
}
