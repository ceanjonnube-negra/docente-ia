// lib/listaOficial/propuestaActualizacionLista.ts
//
// LISTA-P4A — contrato canónico ÚNICO de propuestas para actualizar una
// lista oficial desde el Chat IA: altas, correcciones de CURP y de
// nombre, bajas expresamente solicitadas y registros que no se pudieron
// resolver. Esta fase SOLO define, construye, firma y evalúa el
// contrato — 0 Supabase, 0 IA, 0 escrituras, 0 botones.
//
// Se construye ENCIMA de lo ya existente, nunca en paralelo:
//   - compararListaOficial (matchingListaOficial.ts) decide identidad;
//   - construirPlanDeActualizacionLista (planActualizacionLista.ts)
//     decide qué es automático, qué requiere confirmación y qué es
//     conflicto — aquí solo se traduce su decisión, nunca se relaja;
//   - calcularRosterFingerprint (rosterFingerprint.ts) fija el roster
//     contra el que se generó la propuesta;
//   - firmarCadenaHmacHex/firmaHmacHexCoincide/leerSecretoServerOnly
//     (propuestaFirmada.ts) firman con el mismo secreto, separando el
//     dominio con su propia cadena.
//
// Reglas que este contrato hace cumplir por construcción:
//   - Una confianza alta de lectura NUNCA autoriza por sí sola: la
//     clasificación sale de reglas deterministas y TODA operación
//     aplicable exige una confirmación explícita del docente.
//   - 'requiere_revision' y 'bloqueado' nunca son aplicables con esta
//     versión del contrato: se muestran para que el docente las
//     resuelva, no se confirman.
//   - Una baja jamás se deriva de la ausencia en una fotografía: solo
//     existe si el docente la solicitó identificando al alumno y su
//     inscripción, y se autoriza de forma individual.
//   - Ninguna operación elimina alumnos ni historial: la baja es lógica
//     (estatus de la inscripción) y las correcciones conservan alumnoId.
//
// MÓDULO SERVER-ONLY (node:crypto), igual que propuestaFirmada.ts.

import { createHash } from 'node:crypto'
import type { ConfianzaLecturaLista } from './analisisListaOficial'
import type { CategoriaDiffListaOficial, ResultadoComparacionListaOficial, ResultadoMatchRegistro } from './matchingListaOficial'
import type { OperacionPlanLista, PlanDeActualizacionLista } from './planActualizacionLista'
import { calcularRosterFingerprint } from './rosterFingerprint'
import { firmarCadenaHmacHex, firmaHmacHexCoincide, leerSecretoServerOnly } from './propuestaFirmada'
import { canonicalizarNombreListaOficial } from './canonicalizarNombreListaOficial'
import { normalizarNombre } from '../emparejarAlumno'
import { validarEstructuraCurp } from '../motorContexto'

// ============================================================
// Tipos del contrato
// ============================================================

export const VERSION_PROPUESTA_ACTUALIZACION_LISTA = 1

export type TipoCambioLista = 'alta' | 'correccion_curp' | 'correccion_nombre' | 'baja' | 'registro_sin_resolver'

export type ClasificacionCambioLista = 'seguro' | 'requiere_revision' | 'bloqueado'

export type MotivoRevisionLista =
  | 'IDENTIDAD_NO_CONFIRMADA_POR_CURP'
  | 'CONFIANZA_NOMBRE_INSUFICIENTE'
  | 'LECTURA_DUDOSA'
  | 'ALTA_SIN_CURP_VERIFICABLE'
  | 'FORMATO_NOMBRE_NO_CONVERTIBLE'
  | 'CURP_ACTUAL_NO_REPARABLE_AUTOMATICAMENTE'

export type MotivoBloqueoLista =
  | 'IDENTIDAD_AMBIGUA'
  | 'CURP_DE_OTRO_ALUMNO'
  | 'REGISTRO_DUPLICADO_EN_DOCUMENTO'
  | 'ALTA_DUPLICADA_EN_DOCUMENTO'
  | 'NOMBRE_ILEGIBLE'
  | 'CURP_CONTRADICTORIA'
  | 'BAJA_ALUMNO_NO_IDENTIFICADO'
  | 'BAJA_INSCRIPCION_NO_CORRESPONDE'
  | 'BAJA_INSCRIPCION_NO_ACTIVA'
  | 'SOLICITUD_BAJA_DUPLICADA'

export type MotivoCambioLista = MotivoRevisionLista | MotivoBloqueoLista

// Valores con claves fijas por tipo (ver CLAVES_VALORES_POR_TIPO):
//   alta              actual null              propuesto {nombre, curp}
//   correccion_curp   actual {curp}            propuesto {curp}
//   correccion_nombre actual {nombre}          propuesto {nombre}
//   baja              actual {estatus:activo}  propuesto {estatus:baja}
//   registro_sin_resolver  null / null
// valorActual viaja RAW (sin normalizar): es el valor esperado del
// compare-and-set de la escritura futura.
export type ValoresCambioLista = {
  nombre?: string | null
  curp?: string | null
  estatus?: 'activo' | 'baja'
}

export type EvidenciaCambioLista = {
  fuente: 'documento' | 'solicitud_docente'
  // Posición del registro en el documento (null en bajas solicitadas).
  indiceRegistro: number | null
  nombreLeido: string | null
  nombreConfianza: ConfianzaLecturaLista | null
  curpLeida: string | null
  curpLegible: boolean | null
  curpConfianza: ConfianzaLecturaLista | null
  origenMatch: 'curp' | 'nombre' | 'formato' | 'fuzzy' | null
  categoriaDiff: CategoriaDiffListaOficial | null
}

export type OperacionPropuestaLista = {
  // Hash determinista del contenido de la operación (ver
  // calcularOperacionId) — el validador lo recalcula, así que el id
  // queda atado a lo que la operación propone.
  operacionId: string
  // UUID propio de la operación dentro de ESTA propuesta (ver
  // calcularLlaveOperacion): llave de uso único que recibirá la
  // escritura — mismo papel que p_propuesta_id en
  // confirmar_correccion_alumno, que exige un uuid distinto por
  // corrección. operacionId no sirve para eso: se repite entre
  // propuestas regeneradas con el mismo contenido.
  llaveOperacion: string
  tipo: TipoCambioLista
  clasificacion: ClasificacionCambioLista
  // Vacío solo en 'seguro'; al menos uno en las otras dos.
  motivos: MotivoCambioLista[]
  alumnoId: string | null
  inscripcionId: string | null
  valorActual: ValoresCambioLista | null
  valorPropuesto: ValoresCambioLista | null
  evidencia: EvidenciaCambioLista
  // Firmado siempre como 'pendiente': la confirmación real llega aparte
  // (ConfirmacionOperacionLista), nunca dentro de lo firmado.
  confirmacion: { estado: 'pendiente'; individual: boolean }
}

export type PayloadPropuestaActualizacionLista = {
  version: typeof VERSION_PROPUESTA_ACTUALIZACION_LISTA
  // UUID aleatorio generado por el servidor: llave de uso único de la
  // propuesta completa.
  propuestaId: string
  docenteId: string
  conversacionId: string
  grupoId: string
  rosterFingerprint: string
  generadoEn: string
  expiraEn: string
  operaciones: OperacionPropuestaLista[]
}

export type SobrePropuestaActualizacionLista = {
  payload: PayloadPropuestaActualizacionLista
  firma: string
}

// Lo que enviará la futura ruta de aplicación por cada operación que el
// docente confirme. No existe una forma "confirmar todo": cada
// operación se confirma con su propio elemento, repitiendo la
// identificación del alumno/inscripción. autorizaBaja solo es true en
// bajas.
export type ConfirmacionOperacionLista = {
  operacionId: string
  alumnoId: string | null
  inscripcionId: string | null
  autorizaBaja: boolean
}

// Mínimo del roster activo que necesita el constructor: lo mismo que
// usa calcularRosterFingerprint más nombre/alumnoId.
export type AlumnoRosterPropuesta = {
  alumnoId: string
  inscripcionId: string
  nombre: string
  curp: string | null
  estatus: string
}

export type SolicitudBajaLista = { alumnoId: string; inscripcionId: string }

export class ErrorConstruccionPropuestaLista extends Error {}

// ============================================================
// Utilidades deterministas
// ============================================================

const VIGENCIA_PREDETERMINADA_MINUTOS = 30
const VIGENCIA_MAXIMA_MINUTOS = 120
// Tolerancia de reloj entre instancias del servidor.
const TOLERANCIA_RELOJ_MS = 2 * 60 * 1000
const DOMINIO_HMAC_PROPUESTA_ACTUALIZACION = 'DOCENTE_IA:LISTA_OFICIAL:PROPUESTA_ACTUALIZACION:V1'
const DOMINIO_LLAVE_OPERACION = 'DOCENTE_IA:LISTA_OFICIAL:LLAVE_OPERACION:V1'

// Una sola forma textual por valor: UUID en minúsculas (Postgres acepta
// mayúsculas, pero dos escrituras del mismo uuid no deben circular como
// llaves distintas) y firma HMAC-SHA256 como 64 hex minúsculos (Buffer
// acepta mayúsculas, caracteres sobrantes y nibbles sueltos).
const PATRON_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PATRON_FIRMA_HMAC = /^[0-9a-f]{64}$/

function esUuid(v: unknown): v is string {
  return typeof v === 'string' && PATRON_UUID.test(v)
}

// JSON con claves ordenadas en todos los niveles: la misma propuesta
// lógica produce siempre la misma cadena, sin depender del orden en que
// se construyó cada objeto.
function jsonCanonico(valor: unknown): string {
  if (valor === null || typeof valor !== 'object') return JSON.stringify(valor)
  if (Array.isArray(valor)) return `[${valor.map(jsonCanonico).join(',')}]`
  const o = valor as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`).join(',')}}`
}

function curpNormalizada(curp: string): string {
  return curp.trim().toUpperCase()
}

function curpEsUtilizable(r: ResultadoMatchRegistro['registro']): boolean {
  return !!r.curpLeida && r.curpLegible && r.curpConfianza === 'alta' && validarEstructuraCurp(curpNormalizada(r.curpLeida)).valido
}

function esIsoValido(valor: string): boolean {
  return !Number.isNaN(Date.parse(valor)) && new Date(valor).toISOString() === valor
}

export function calcularOperacionId(grupoId: string, op: Omit<OperacionPropuestaLista, 'operacionId' | 'llaveOperacion' | 'clasificacion' | 'motivos' | 'confirmacion'>): string {
  const contenido = {
    grupoId,
    tipo: op.tipo,
    alumnoId: op.alumnoId,
    inscripcionId: op.inscripcionId,
    valorActual: op.valorActual,
    valorPropuesto: op.valorPropuesto,
    indiceRegistro: op.evidencia.indiceRegistro,
  }
  return createHash('sha256').update(jsonCanonico(contenido)).digest('hex').slice(0, 32)
}

// UUID determinista (formato RFC 9562, versión 8) derivado de la
// propuesta y la operación: único por operación dentro de una propuesta,
// distinto entre propuestas, y recalculable por el validador.
export function calcularLlaveOperacion(propuestaId: string, operacionId: string): string {
  const b = createHash('sha256').update(`${DOMINIO_LLAVE_OPERACION}\n${propuestaId}\n${operacionId}`).digest().subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x80
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// ============================================================
// Constructor — traduce comparación + plan (+ bajas solicitadas) al
// contrato. Nunca decide identidad: solo usa lo que ya resolvieron
// compararListaOficial y construirPlanDeActualizacionLista.
// ============================================================

type OperacionSinId = Omit<OperacionPropuestaLista, 'operacionId' | 'llaveOperacion'>

function evidenciaDeRegistro(r: ResultadoMatchRegistro, indice: number): EvidenciaCambioLista {
  return {
    fuente: 'documento',
    indiceRegistro: indice,
    nombreLeido: r.registro.nombreLeido,
    nombreConfianza: r.registro.nombreConfianza,
    curpLeida: r.registro.curpLeida,
    curpLegible: r.registro.curpLegible,
    curpConfianza: r.registro.curpConfianza,
    origenMatch: r.origenMatch ?? null,
    categoriaDiff: r.categoriaDiff,
  }
}

function operacion(
  tipo: TipoCambioLista,
  motivos: MotivoCambioLista[],
  clasificacionSiHayMotivos: 'requiere_revision' | 'bloqueado',
  datos: Pick<OperacionSinId, 'alumnoId' | 'inscripcionId' | 'valorActual' | 'valorPropuesto' | 'evidencia'>
): OperacionSinId {
  return {
    tipo,
    clasificacion: motivos.length === 0 ? 'seguro' : clasificacionSiHayMotivos,
    motivos,
    ...datos,
    confirmacion: { estado: 'pendiente', individual: tipo === 'baja' },
  }
}

// Corrección de nombre: solo cuando el registro ya está asociado a un
// alumno y su nombre leído difiere del guardado (tras normalizar).
// Segura únicamente con identidad por CURP + confianza alta + nombre en
// texto plano (un nombre en formato APELLIDO/APELLIDO*NOMBRE no se
// convierte a texto oficial aquí).
function correccionNombre(r: ResultadoMatchRegistro, indice: number, alumno: AlumnoRosterPropuesta): OperacionSinId | null {
  const nombreLeido = r.registro.nombreLeido?.trim()
  if (!nombreLeido || r.origenMatch === 'nombre' || r.origenMatch === 'formato') return null
  if (normalizarNombre(nombreLeido) === normalizarNombre(alumno.nombre)) return null
  const formato = canonicalizarNombreListaOficial(nombreLeido)
  if (formato.valido && formato.nombreCanonical === normalizarNombre(alumno.nombre)) return null

  const motivos: MotivoCambioLista[] = []
  if (r.origenMatch !== 'curp') motivos.push('IDENTIDAD_NO_CONFIRMADA_POR_CURP')
  if (r.registro.nombreConfianza !== 'alta') motivos.push('CONFIANZA_NOMBRE_INSUFICIENTE')
  if (formato.valido) motivos.push('FORMATO_NOMBRE_NO_CONVERTIBLE')
  return operacion('correccion_nombre', motivos, 'requiere_revision', {
    alumnoId: alumno.alumnoId,
    inscripcionId: alumno.inscripcionId,
    valorActual: { nombre: alumno.nombre },
    valorPropuesto: { nombre: nombreLeido },
    evidencia: evidenciaDeRegistro(r, indice),
  })
}

// Corrección de CURP fuera de las 2 vías seguras del plan: nunca
// 'seguro'. Si la CURP guardada es válida y la leída es otra válida,
// es contradicción: bloqueada, jamás se sobrescribe.
function correccionCurpNoSegura(r: ResultadoMatchRegistro, indice: number, alumno: AlumnoRosterPropuesta): OperacionSinId | null {
  if (!r.registro.curpLeida) return null
  const leida = curpNormalizada(r.registro.curpLeida)
  const actual = alumno.curp
  if (actual && curpNormalizada(actual) === leida) return null

  const evidencia = evidenciaDeRegistro(r, indice)
  const datos = { alumnoId: alumno.alumnoId, inscripcionId: alumno.inscripcionId, valorActual: { curp: actual }, valorPropuesto: { curp: leida }, evidencia }

  const actualValida = !!actual && validarEstructuraCurp(curpNormalizada(actual)).valido
  if (actualValida && curpEsUtilizable(r.registro)) {
    return operacion('correccion_curp', ['CURP_CONTRADICTORIA'], 'bloqueado', datos)
  }
  const motivos: MotivoCambioLista[] = []
  if (!curpEsUtilizable(r.registro)) motivos.push('LECTURA_DUDOSA')
  if (r.origenMatch !== 'curp' && r.origenMatch !== 'nombre') motivos.push('IDENTIDAD_NO_CONFIRMADA_POR_CURP')
  if (r.origenMatch === 'nombre' && r.registro.nombreConfianza !== 'alta') motivos.push('CONFIANZA_NOMBRE_INSUFICIENTE')
  if (actualValida) motivos.push('CURP_ACTUAL_NO_REPARABLE_AUTOMATICAMENTE')
  if (motivos.length === 0) motivos.push('IDENTIDAD_NO_CONFIRMADA_POR_CURP')
  return operacion('correccion_curp', motivos, 'requiere_revision', datos)
}

function altaDesdeRegistro(r: ResultadoMatchRegistro, indice: number): OperacionSinId {
  const evidencia = evidenciaDeRegistro(r, indice)
  const nombre = r.registro.nombreLeido?.trim() || null
  const utilizable = curpEsUtilizable(r.registro)
  const curp = utilizable && r.registro.curpLeida ? curpNormalizada(r.registro.curpLeida) : null
  const datos = { alumnoId: null, inscripcionId: null, valorActual: null, valorPropuesto: { nombre, curp }, evidencia }

  if (!nombre) return operacion('alta', ['NOMBRE_ILEGIBLE'], 'bloqueado', datos)
  const motivos: MotivoCambioLista[] = []
  if (r.registro.curpLeida && !utilizable) motivos.push('LECTURA_DUDOSA')
  // Sin CURP verificable no se puede descartar que la persona ya exista
  // (homónimo, otro grupo, otro ciclo) ni impedir altas repetidas.
  if (!curp) motivos.push('ALTA_SIN_CURP_VERIFICABLE')
  if (r.registro.nombreConfianza !== 'alta') motivos.push('CONFIANZA_NOMBRE_INSUFICIENTE')
  if (canonicalizarNombreListaOficial(nombre).valido) motivos.push('FORMATO_NOMBRE_NO_CONVERTIBLE')
  return operacion('alta', motivos, 'requiere_revision', datos)
}

function sinResolver(r: ResultadoMatchRegistro, indice: number, motivo: MotivoBloqueoLista, inscripcionId: string | null): OperacionSinId {
  return operacion('registro_sin_resolver', [motivo], 'bloqueado', {
    alumnoId: r.alumnoId ?? null,
    inscripcionId,
    valorActual: null,
    valorPropuesto: null,
    evidencia: evidenciaDeRegistro(r, indice),
  })
}

function operacionesDeRegistro(
  r: ResultadoMatchRegistro,
  planOp: OperacionPlanLista,
  indice: number,
  rosterPorAlumnoId: Map<string, AlumnoRosterPropuesta>
): OperacionSinId[] {
  if (planOp.categoria === 'CONFLICTO_BLOQUEANTE') {
    const inscripcionId = r.alumnoId ? rosterPorAlumnoId.get(r.alumnoId)?.inscripcionId ?? null : null
    const motivo: MotivoBloqueoLista =
      r.categoriaDiff === 'CURP_DUPLICADA' ? 'CURP_DE_OTRO_ALUMNO' : r.categoriaDiff === 'REGISTRO_DUPLICADO_EN_DOCUMENTO' ? 'REGISTRO_DUPLICADO_EN_DOCUMENTO' : 'IDENTIDAD_AMBIGUA'
    return [sinResolver(r, indice, motivo, inscripcionId)]
  }
  if (planOp.categoria === 'ALUMNO_NUEVO') return [altaDesdeRegistro(r, indice)]
  // RETIRAR_INSCRIPCION nunca llega aquí: solo sale de ausentes.

  const alumno = r.alumnoId ? rosterPorAlumnoId.get(r.alumnoId) : undefined
  if (!alumno) {
    throw new ErrorConstruccionPropuestaLista('Un resultado asociado a un alumno no existe en el roster recibido — comparación y roster deben derivar del mismo roster.')
  }

  const ops: OperacionSinId[] = []
  if (planOp.categoria === 'ACTUALIZAR_DATOS') {
    // Una de las 2 vías seguras ya decididas por el plan.
    ops.push(
      operacion('correccion_curp', [], 'requiere_revision', {
        alumnoId: alumno.alumnoId,
        inscripcionId: alumno.inscripcionId,
        valorActual: { curp: planOp.valorActual ?? null },
        valorPropuesto: { curp: curpNormalizada(planOp.valorPropuesto ?? '') },
        evidencia: evidenciaDeRegistro(r, indice),
      })
    )
  } else if (planOp.categoria === 'REQUIERE_CONFIRMACION') {
    const curp = correccionCurpNoSegura(r, indice, alumno)
    if (curp) ops.push(curp)
  }
  const nombre = correccionNombre(r, indice, alumno)
  if (nombre) ops.push(nombre)
  return ops
}

// Altas que se repiten dentro del mismo documento (misma CURP o mismo
// nombre normalizado): se bloquean TODAS, sin elegir "la primera".
function bloquearAltasDuplicadas(ops: OperacionSinId[]): OperacionSinId[] {
  const conteo = new Map<string, number>()
  const llaves = (op: OperacionSinId): string[] => {
    if (op.tipo !== 'alta' || !op.valorPropuesto) return []
    const out: string[] = []
    if (op.valorPropuesto.curp) out.push(`curp:${op.valorPropuesto.curp}`)
    if (op.valorPropuesto.nombre) out.push(`nombre:${normalizarNombre(op.valorPropuesto.nombre)}`)
    return out
  }
  for (const op of ops) for (const k of llaves(op)) conteo.set(k, (conteo.get(k) ?? 0) + 1)
  return ops.map((op) =>
    llaves(op).some((k) => (conteo.get(k) ?? 0) > 1)
      ? { ...op, clasificacion: 'bloqueado' as const, motivos: ['ALTA_DUPLICADA_EN_DOCUMENTO' as const] }
      : op
  )
}

function operacionesDeBaja(solicitudes: SolicitudBajaLista[], rosterPorAlumnoId: Map<string, AlumnoRosterPropuesta>): OperacionSinId[] {
  // Una solicitud idéntica repetida es la misma solicitud: se cuenta
  // una vez. Otra solicitud distinta para el mismo alumno se bloquea.
  const unicas = solicitudes.filter((s, i) => solicitudes.findIndex((t) => t.alumnoId === s.alumnoId && t.inscripcionId === s.inscripcionId) === i)
  const vistas = new Set<string>()
  return unicas.map((s) => {
    const alumno = rosterPorAlumnoId.get(s.alumnoId)
    const evidencia: EvidenciaCambioLista = {
      fuente: 'solicitud_docente', indiceRegistro: null, nombreLeido: null, nombreConfianza: null,
      curpLeida: null, curpLegible: null, curpConfianza: null, origenMatch: null, categoriaDiff: null,
    }
    const datos = { alumnoId: s.alumnoId, inscripcionId: s.inscripcionId, valorActual: { estatus: 'activo' as const }, valorPropuesto: { estatus: 'baja' as const }, evidencia }
    let motivo: MotivoBloqueoLista | null = null
    if (vistas.has(s.alumnoId)) motivo = 'SOLICITUD_BAJA_DUPLICADA'
    else if (!alumno) motivo = 'BAJA_ALUMNO_NO_IDENTIFICADO'
    else if (alumno.inscripcionId !== s.inscripcionId) motivo = 'BAJA_INSCRIPCION_NO_CORRESPONDE'
    else if (alumno.estatus !== 'activo') motivo = 'BAJA_INSCRIPCION_NO_ACTIVA'
    vistas.add(s.alumnoId)
    return operacion('baja', motivo ? [motivo] : [], 'bloqueado', datos)
  })
}

export function construirPropuestaActualizacionLista(params: {
  propuestaId: string
  docenteId: string
  conversacionId: string
  grupoId: string
  generadoEn: string
  vigenciaMinutos?: number
  roster: AlumnoRosterPropuesta[]
  comparacion: ResultadoComparacionListaOficial
  plan: PlanDeActualizacionLista
  // Únicamente bajas que el docente pidió de forma explícita. La
  // ausencia en el documento (RETIRAR_INSCRIPCION del plan) se ignora.
  solicitudesBaja?: SolicitudBajaLista[]
  // null cuando no hay nada que proponer (todo coincide): una propuesta
  // vacía nunca se firma.
}): PayloadPropuestaActualizacionLista | null {
  const { plan, comparacion, roster } = params
  if (plan.grupoId !== params.grupoId) {
    throw new ErrorConstruccionPropuestaLista('El plan pertenece a otro grupo.')
  }
  const rosterFingerprint = calcularRosterFingerprint(roster.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp })))
  if (plan.rosterFingerprint !== rosterFingerprint) {
    throw new ErrorConstruccionPropuestaLista('El plan se generó contra otro roster.')
  }
  const opsDeResultados = plan.operaciones.slice(0, comparacion.resultados.length)
  if (opsDeResultados.length !== comparacion.resultados.length || opsDeResultados.some((op) => op.categoria === 'RETIRAR_INSCRIPCION')) {
    throw new ErrorConstruccionPropuestaLista('El plan no corresponde a la comparación recibida.')
  }
  const vigencia = params.vigenciaMinutos ?? VIGENCIA_PREDETERMINADA_MINUTOS
  if (!(vigencia > 0 && vigencia <= VIGENCIA_MAXIMA_MINUTOS) || !esIsoValido(params.generadoEn)) {
    throw new ErrorConstruccionPropuestaLista('Vigencia o fecha de generación inválida.')
  }

  const rosterPorAlumnoId = new Map(roster.map((a) => [a.alumnoId, a]))
  const opsDocumento = comparacion.resultados.flatMap((r, i) => operacionesDeRegistro(r, opsDeResultados[i], i, rosterPorAlumnoId))
  const ops = [...bloquearAltasDuplicadas(opsDocumento), ...operacionesDeBaja(params.solicitudesBaja ?? [], rosterPorAlumnoId)]
  if (ops.length === 0) return null

  const payload: PayloadPropuestaActualizacionLista = {
    version: VERSION_PROPUESTA_ACTUALIZACION_LISTA,
    propuestaId: params.propuestaId,
    docenteId: params.docenteId,
    conversacionId: params.conversacionId,
    grupoId: params.grupoId,
    rosterFingerprint,
    generadoEn: params.generadoEn,
    expiraEn: new Date(Date.parse(params.generadoEn) + vigencia * 60_000).toISOString(),
    operaciones: ops.map((op) => {
      const operacionId = calcularOperacionId(params.grupoId, op)
      return { operacionId, llaveOperacion: calcularLlaveOperacion(params.propuestaId, operacionId), ...op }
    }),
  }
  if (!esPayloadPropuestaActualizacionListaValido(payload)) {
    throw new ErrorConstruccionPropuestaLista('La propuesta construida no cumple el contrato.')
  }
  return payload
}

// ============================================================
// Validación estructural — whitelist exacta por nivel y por tipo
// ============================================================

function tieneExactamenteLasClaves(obj: Record<string, unknown>, claves: readonly string[]): boolean {
  const propias = Object.keys(obj)
  return propias.length === claves.length && claves.every((c) => Object.prototype.hasOwnProperty.call(obj, c))
}

function esTextoNoVacio(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

const CLAVES_PAYLOAD = ['version', 'propuestaId', 'docenteId', 'conversacionId', 'grupoId', 'rosterFingerprint', 'generadoEn', 'expiraEn', 'operaciones'] as const
const CLAVES_OPERACION = ['operacionId', 'llaveOperacion', 'tipo', 'clasificacion', 'motivos', 'alumnoId', 'inscripcionId', 'valorActual', 'valorPropuesto', 'evidencia', 'confirmacion'] as const
const CLAVES_EVIDENCIA = ['fuente', 'indiceRegistro', 'nombreLeido', 'nombreConfianza', 'curpLeida', 'curpLegible', 'curpConfianza', 'origenMatch', 'categoriaDiff'] as const
const CLAVES_SOBRE = ['payload', 'firma'] as const
const CLAVES_CONFIRMACION = ['operacionId', 'alumnoId', 'inscripcionId', 'autorizaBaja'] as const

const CLAVES_VALORES_POR_TIPO: Record<TipoCambioLista, { actual: readonly string[] | null; propuesto: readonly string[] | null }> = {
  alta: { actual: null, propuesto: ['nombre', 'curp'] },
  correccion_curp: { actual: ['curp'], propuesto: ['curp'] },
  correccion_nombre: { actual: ['nombre'], propuesto: ['nombre'] },
  baja: { actual: ['estatus'], propuesto: ['estatus'] },
  registro_sin_resolver: { actual: null, propuesto: null },
}

const MOTIVOS_REVISION: readonly MotivoRevisionLista[] = [
  'IDENTIDAD_NO_CONFIRMADA_POR_CURP', 'CONFIANZA_NOMBRE_INSUFICIENTE', 'LECTURA_DUDOSA',
  'ALTA_SIN_CURP_VERIFICABLE', 'FORMATO_NOMBRE_NO_CONVERTIBLE', 'CURP_ACTUAL_NO_REPARABLE_AUTOMATICAMENTE',
]
const MOTIVOS_BLOQUEO: readonly MotivoBloqueoLista[] = [
  'IDENTIDAD_AMBIGUA', 'CURP_DE_OTRO_ALUMNO', 'REGISTRO_DUPLICADO_EN_DOCUMENTO', 'ALTA_DUPLICADA_EN_DOCUMENTO',
  'NOMBRE_ILEGIBLE', 'CURP_CONTRADICTORIA', 'BAJA_ALUMNO_NO_IDENTIFICADO', 'BAJA_INSCRIPCION_NO_CORRESPONDE',
  'BAJA_INSCRIPCION_NO_ACTIVA', 'SOLICITUD_BAJA_DUPLICADA',
]

function sonValoresValidos(v: unknown, claves: readonly string[] | null): boolean {
  if (claves === null) return v === null
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, claves)) return false
  return claves.every((k) => (k === 'estatus' ? o[k] === 'activo' || o[k] === 'baja' : o[k] === null || esTextoNoVacio(o[k])))
}

function esEvidenciaValida(v: unknown): v is EvidenciaCambioLista {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_EVIDENCIA)) return false
  if (o.fuente !== 'documento' && o.fuente !== 'solicitud_docente') return false
  if (o.fuente === 'documento') return typeof o.indiceRegistro === 'number' && Number.isInteger(o.indiceRegistro) && o.indiceRegistro >= 0
  // Una baja solicitada no trae ninguna lectura del documento.
  return CLAVES_EVIDENCIA.every((k) => k === 'fuente' || o[k] === null)
}

function esOperacionValida(v: unknown, grupoId: string, propuestaId: string): v is OperacionPropuestaLista {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_OPERACION)) return false
  if (typeof o.tipo !== 'string' || !Object.prototype.hasOwnProperty.call(CLAVES_VALORES_POR_TIPO, o.tipo)) return false
  const tipo = o.tipo as TipoCambioLista
  if (!esEvidenciaValida(o.evidencia)) return false
  const ev = o.evidencia as EvidenciaCambioLista
  const claves = CLAVES_VALORES_POR_TIPO[tipo]
  if (!sonValoresValidos(o.valorActual, claves.actual) || !sonValoresValidos(o.valorPropuesto, claves.propuesto)) return false
  if (!(o.alumnoId === null || esTextoNoVacio(o.alumnoId)) || !(o.inscripcionId === null || esTextoNoVacio(o.inscripcionId))) return false

  // Motivos coherentes con la clasificación.
  if (!Array.isArray(o.motivos)) return false
  const motivos = o.motivos as unknown[]
  if (o.clasificacion === 'seguro') {
    if (motivos.length !== 0) return false
  } else if (o.clasificacion === 'requiere_revision') {
    if (motivos.length === 0 || !motivos.every((m) => (MOTIVOS_REVISION as readonly unknown[]).includes(m))) return false
  } else if (o.clasificacion === 'bloqueado') {
    if (motivos.length === 0 || !motivos.every((m) => (MOTIVOS_BLOQUEO as readonly unknown[]).includes(m))) return false
  } else return false

  // Invariantes por tipo.
  if (tipo === 'alta' && (o.alumnoId !== null || o.inscripcionId !== null)) return false
  if ((tipo === 'correccion_curp' || tipo === 'correccion_nombre' || tipo === 'baja') && !(esTextoNoVacio(o.alumnoId) && esTextoNoVacio(o.inscripcionId))) return false
  if (tipo === 'registro_sin_resolver' && o.clasificacion !== 'bloqueado') return false
  // Una baja solo nace de una solicitud del docente, nunca del documento;
  // y nada que venga del documento puede proponer una baja.
  if ((tipo === 'baja') !== (ev.fuente === 'solicitud_docente')) return false
  if (tipo === 'baja') {
    const actual = o.valorActual as ValoresCambioLista
    const propuesto = o.valorPropuesto as ValoresCambioLista
    if (actual.estatus !== 'activo' || propuesto.estatus !== 'baja') return false
  }
  if (o.clasificacion === 'seguro') {
    const p = o.valorPropuesto as ValoresCambioLista | null
    if (tipo === 'alta' && !(p && esTextoNoVacio(p.nombre) && esTextoNoVacio(p.curp))) return false
    if (tipo === 'correccion_curp' && !(p && esTextoNoVacio(p.curp) && validarEstructuraCurp(p.curp).valido)) return false
    if (tipo === 'correccion_nombre' && !(p && esTextoNoVacio(p.nombre))) return false
  }

  const conf = o.confirmacion as Record<string, unknown> | null
  if (typeof conf !== 'object' || conf === null || !tieneExactamenteLasClaves(conf, ['estado', 'individual'])) return false
  if (conf.estado !== 'pendiente' || conf.individual !== (tipo === 'baja')) return false

  if (typeof o.operacionId !== 'string' || o.operacionId !== calcularOperacionId(grupoId, o as unknown as OperacionPropuestaLista)) return false
  return esUuid(o.llaveOperacion) && o.llaveOperacion === calcularLlaveOperacion(propuestaId, o.operacionId)
}

export function esPayloadPropuestaActualizacionListaValido(v: unknown): v is PayloadPropuestaActualizacionLista {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_PAYLOAD)) return false
  if (o.version !== VERSION_PROPUESTA_ACTUALIZACION_LISTA) return false
  if (![o.docenteId, o.grupoId, o.rosterFingerprint].every(esTextoNoVacio)) return false
  if (!esUuid(o.propuestaId) || !esUuid(o.conversacionId)) return false
  if (!esTextoNoVacio(o.generadoEn) || !esTextoNoVacio(o.expiraEn) || !esIsoValido(o.generadoEn) || !esIsoValido(o.expiraEn)) return false
  const vigenciaMs = Date.parse(o.expiraEn) - Date.parse(o.generadoEn)
  if (!(vigenciaMs > 0 && vigenciaMs <= VIGENCIA_MAXIMA_MINUTOS * 60_000)) return false
  if (!Array.isArray(o.operaciones) || o.operaciones.length === 0) return false
  const grupoId = o.grupoId as string
  const propuestaId = o.propuestaId
  if (!o.operaciones.every((op) => esOperacionValida(op, grupoId, propuestaId))) return false
  const operaciones = o.operaciones as OperacionPropuestaLista[]
  const ids = operaciones.map((op) => op.operacionId)
  const llaves = new Set(operaciones.map((op) => op.llaveOperacion))
  return new Set(ids).size === ids.length && llaves.size === operaciones.length && !llaves.has(propuestaId)
}

// ============================================================
// Firma — mismo HMAC y mismo secreto que propuestaFirmada.ts, con
// dominio propio para que ningún sobre de un contrato valga en el otro.
// ============================================================

function cadenaParaFirmar(payload: PayloadPropuestaActualizacionLista): string {
  return `${DOMINIO_HMAC_PROPUESTA_ACTUALIZACION}\n${jsonCanonico(payload)}`
}

export function firmarPropuestaActualizacionConSecreto(payload: PayloadPropuestaActualizacionLista, secreto: string): SobrePropuestaActualizacionLista {
  if (!esPayloadPropuestaActualizacionListaValido(payload)) {
    throw new ErrorConstruccionPropuestaLista('Propuesta de actualización inválida — no se firma.')
  }
  return { payload, firma: firmarCadenaHmacHex(cadenaParaFirmar(payload), secreto) }
}

export function verificarPropuestaActualizacionConSecreto(sobre: unknown, secreto: string): sobre is SobrePropuestaActualizacionLista {
  if (typeof sobre !== 'object' || sobre === null) return false
  const o = sobre as Record<string, unknown>
  if (!tieneExactamenteLasClaves(o, CLAVES_SOBRE) || typeof o.firma !== 'string' || !PATRON_FIRMA_HMAC.test(o.firma)) return false
  if (!esPayloadPropuestaActualizacionListaValido(o.payload)) return false
  return firmaHmacHexCoincide(o.firma, cadenaParaFirmar(o.payload), secreto)
}

// API de producción: fail-closed sin secreto real (no se configura en
// esta fase).
export function firmarPropuestaActualizacionLista(payload: PayloadPropuestaActualizacionLista): SobrePropuestaActualizacionLista {
  const secreto = leerSecretoServerOnly()
  if (!secreto) throw new Error('LISTA_OFICIAL_HMAC_SECRET_KEY ausente o inválida — no se firma sin secreto real (fail-closed).')
  return firmarPropuestaActualizacionConSecreto(payload, secreto)
}

// ============================================================
// Evaluación de una solicitud de aplicación — contrato que usará la
// futura ruta ANTES de escribir. Pura: el llamador aporta el contexto
// real (docente autenticado, grupo activo, huella del roster actual,
// hora del servidor, si la propuesta ya se consumió). Todo o nada: si
// cualquier confirmación es inválida, no se autoriza ninguna.
//
// No sustituye la revalidación transaccional de la escritura (CAS,
// ownership, inscripción activa, uso único en BD): solo garantiza que
// nada llegue a esa etapa sin cumplir el contrato.
// ============================================================

export type CodigoRechazoPropuestaLista =
  | 'FIRMA_INVALIDA'
  | 'DOCENTE_NO_CORRESPONDE'
  | 'CONVERSACION_NO_CORRESPONDE'
  | 'GRUPO_NO_CORRESPONDE'
  | 'PROPUESTA_NO_VIGENTE'
  | 'PROPUESTA_CADUCADA'
  | 'PROPUESTA_YA_APLICADA'
  | 'ROSTER_CAMBIO'
  | 'SIN_CONFIRMACIONES'
  | 'CONFIRMACIONES_INVALIDAS'

export type CodigoRechazoConfirmacionLista =
  | 'CONFIRMACION_DUPLICADA'
  | 'OPERACION_NO_EXISTE'
  | 'OPERACION_NO_APLICABLE'
  | 'IDENTIFICACION_NO_CORRESPONDE'
  | 'BAJA_SIN_AUTORIZACION_INDIVIDUAL'
  | 'AUTORIZACION_BAJA_INDEBIDA'

export type ContextoEvaluacionPropuestaLista = {
  docenteId: string
  conversacionId: string
  grupoId: string
  rosterFingerprintActual: string
  ahora: Date
  propuestaYaAplicada: boolean
}

export type ResultadoEvaluacionPropuestaLista =
  | { ok: true; propuestaId: string; operacionesAutorizadas: OperacionPropuestaLista[] }
  | { ok: false; codigo: CodigoRechazoPropuestaLista; rechazos: { operacionId: string; codigo: CodigoRechazoConfirmacionLista }[] }

function esConfirmacionValida(v: unknown): v is ConfirmacionOperacionLista {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    tieneExactamenteLasClaves(o, CLAVES_CONFIRMACION) &&
    esTextoNoVacio(o.operacionId) &&
    (o.alumnoId === null || esTextoNoVacio(o.alumnoId)) &&
    (o.inscripcionId === null || esTextoNoVacio(o.inscripcionId)) &&
    typeof o.autorizaBaja === 'boolean'
  )
}

export function evaluarSolicitudAplicacionLista(params: {
  sobre: unknown
  secreto: string
  confirmaciones: unknown
  contexto: ContextoEvaluacionPropuestaLista
}): ResultadoEvaluacionPropuestaLista {
  const rechazo = (codigo: CodigoRechazoPropuestaLista, rechazos: { operacionId: string; codigo: CodigoRechazoConfirmacionLista }[] = []) =>
    ({ ok: false, codigo, rechazos }) as const
  const { contexto } = params

  if (!verificarPropuestaActualizacionConSecreto(params.sobre, params.secreto)) return rechazo('FIRMA_INVALIDA')
  const p = params.sobre.payload
  if (p.docenteId !== contexto.docenteId) return rechazo('DOCENTE_NO_CORRESPONDE')
  if (p.conversacionId !== contexto.conversacionId) return rechazo('CONVERSACION_NO_CORRESPONDE')
  if (p.grupoId !== contexto.grupoId) return rechazo('GRUPO_NO_CORRESPONDE')
  const ahora = contexto.ahora.getTime()
  if (ahora + TOLERANCIA_RELOJ_MS < Date.parse(p.generadoEn)) return rechazo('PROPUESTA_NO_VIGENTE')
  if (ahora >= Date.parse(p.expiraEn)) return rechazo('PROPUESTA_CADUCADA')
  if (contexto.propuestaYaAplicada) return rechazo('PROPUESTA_YA_APLICADA')
  if (p.rosterFingerprint !== contexto.rosterFingerprintActual) return rechazo('ROSTER_CAMBIO')

  if (!Array.isArray(params.confirmaciones)) return rechazo('CONFIRMACIONES_INVALIDAS')
  if (params.confirmaciones.length === 0) return rechazo('SIN_CONFIRMACIONES')
  if (!params.confirmaciones.every(esConfirmacionValida)) return rechazo('CONFIRMACIONES_INVALIDAS')
  const confirmaciones = params.confirmaciones as ConfirmacionOperacionLista[]

  const porId = new Map(p.operaciones.map((op) => [op.operacionId, op]))
  const vistas = new Set<string>()
  const rechazos: { operacionId: string; codigo: CodigoRechazoConfirmacionLista }[] = []
  const autorizadas: OperacionPropuestaLista[] = []
  for (const c of confirmaciones) {
    const op = porId.get(c.operacionId)
    let codigo: CodigoRechazoConfirmacionLista | null = null
    if (vistas.has(c.operacionId)) codigo = 'CONFIRMACION_DUPLICADA'
    else if (!op) codigo = 'OPERACION_NO_EXISTE'
    else if (op.clasificacion !== 'seguro') codigo = 'OPERACION_NO_APLICABLE'
    else if (c.alumnoId !== op.alumnoId || c.inscripcionId !== op.inscripcionId) codigo = 'IDENTIFICACION_NO_CORRESPONDE'
    else if (op.tipo === 'baja' && !c.autorizaBaja) codigo = 'BAJA_SIN_AUTORIZACION_INDIVIDUAL'
    else if (op.tipo !== 'baja' && c.autorizaBaja) codigo = 'AUTORIZACION_BAJA_INDEBIDA'
    vistas.add(c.operacionId)
    if (codigo) rechazos.push({ operacionId: c.operacionId, codigo })
    else if (op) autorizadas.push(op)
  }
  if (rechazos.length > 0) return rechazo('CONFIRMACIONES_INVALIDAS', rechazos)
  return { ok: true, propuestaId: p.propuestaId, operacionesAutorizadas: autorizadas }
}
