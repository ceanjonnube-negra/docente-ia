// scripts/verificar-propuesta-actualizacion-lista.ts
//
// LISTA-P4A — pruebas deterministas (sin credenciales, sin red, sin IA,
// solo datos ficticios) del contrato canónico de propuestas de
// actualización de lista oficial (lib/listaOficial/
// propuestaActualizacionLista.ts). Usa las funciones REALES de
// comparación, reparación de CURP, plan y huella — nunca una segunda
// implementación.
//
// Se ejecuta con `npx tsx scripts/verificar-propuesta-actualizacion-lista.ts`.

import { compararListaOficial } from '../lib/listaOficial/matchingListaOficial'
import { clasificarPropuestasReparacionCurp } from '../lib/listaOficial/propuestasReparacionCurp'
import { construirPlanDeActualizacionLista } from '../lib/listaOficial/planActualizacionLista'
import { calcularRosterFingerprint } from '../lib/listaOficial/rosterFingerprint'
import { firmarConSecreto, verificarConSecreto } from '../lib/listaOficial/propuestaFirmada'
import type { RegistroExtraidoListaOficial, ConfianzaLecturaLista } from '../lib/listaOficial/analisisListaOficial'
import {
  construirPropuestaActualizacionLista,
  esPayloadPropuestaActualizacionListaValido,
  evaluarSolicitudAplicacionLista,
  firmarPropuestaActualizacionConSecreto,
  firmarPropuestaActualizacionLista,
  verificarPropuestaActualizacionConSecreto,
  ErrorConstruccionPropuestaLista,
  type AlumnoRosterPropuesta,
  type ConfirmacionOperacionLista,
  type ContextoEvaluacionPropuestaLista,
  type OperacionPropuestaLista,
  type PayloadPropuestaActualizacionLista,
  type SolicitudBajaLista,
} from '../lib/listaOficial/propuestaActualizacionLista'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function lanza(fn: () => unknown, tipo: new (...args: never[]) => Error = Error): boolean {
  try {
    fn()
    return false
  } catch (e) {
    return e instanceof tipo
  }
}

function registro(
  nombreLeido: string | null,
  nombreConfianza: ConfianzaLecturaLista,
  curpLeida: string | null,
  curpLegible = true,
  curpConfianza: ConfianzaLecturaLista = 'alta'
): RegistroExtraidoListaOficial {
  return { nombreLeido, nombreConfianza, curpLeida, curpLegible, curpConfianza }
}

const SECRETO = 'secreto-ficticio-solo-para-pruebas'
const GENERADO_EN = '2026-10-27T15:00:00.000Z'

// Construye comparación + plan + propuesta con el pipeline real.
function propuestaDe(params: {
  grupoId?: string
  roster: AlumnoRosterPropuesta[]
  documento: RegistroExtraidoListaOficial[]
  solicitudesBaja?: SolicitudBajaLista[]
  vigenciaMinutos?: number
  generadoEn?: string
  propuestaId?: string
  rosterParaPlan?: AlumnoRosterPropuesta[]
}): PayloadPropuestaActualizacionLista | null {
  const grupoId = params.grupoId ?? 'grupo-1'
  const rosterPlan = params.rosterParaPlan ?? params.roster
  const rosterMatching = rosterPlan.map((a) => ({ id: a.alumnoId, nombre: a.nombre, curp: a.curp }))
  const comparacion = compararListaOficial(params.documento, rosterMatching)
  const reparacion = clasificarPropuestasReparacionCurp(comparacion, rosterMatching)
  const plan = construirPlanDeActualizacionLista({
    grupoId,
    rosterFingerprint: calcularRosterFingerprint(rosterPlan.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp }))),
    generadoEn: params.generadoEn ?? GENERADO_EN,
    comparacion,
    propuestasReparacionCurp: { candidatos: reparacion.candidatos, totalCurpDiferente: reparacion.totalCurpDiferente, totalNoAccionables: reparacion.totalNoAccionables },
    roster: rosterPlan.map((a) => ({ id: a.alumnoId, inscripcionId: a.inscripcionId })),
  })
  return construirPropuestaActualizacionLista({
    propuestaId: params.propuestaId ?? 'propuesta-1',
    docenteId: 'docente-1',
    conversacionId: 'conversacion-1',
    grupoId,
    generadoEn: params.generadoEn ?? GENERADO_EN,
    vigenciaMinutos: params.vigenciaMinutos,
    roster: params.roster,
    comparacion,
    plan,
    solicitudesBaja: params.solicitudesBaja,
  })
}

const huella = (roster: AlumnoRosterPropuesta[]) =>
  calcularRosterFingerprint(roster.map((a) => ({ inscripcionId: a.inscripcionId, estatus: a.estatus, curp: a.curp })))

function confirmar(op: OperacionPropuestaLista, autorizaBaja = op.tipo === 'baja'): ConfirmacionOperacionLista {
  return { operacionId: op.operacionId, alumnoId: op.alumnoId, inscripcionId: op.inscripcionId, autorizaBaja }
}

// ============================================================
// Escenario principal — grupo-1 (datos ficticios)
// ============================================================

const ROSTER: AlumnoRosterPropuesta[] = [
  { alumnoId: 'a1', inscripcionId: 'i1', nombre: 'Juan Perez Lopez', curp: 'JULO100101HDFPRN03', estatus: 'activo' },
  { alumnoId: 'a2', inscripcionId: 'i2', nombre: 'Maria Lopez Garcia', curp: null, estatus: 'activo' },
  { alumnoId: 'a3', inscripcionId: 'i3', nombre: 'Carlos Ruiz Mendez', curp: 'CURPINVALIDA', estatus: 'activo' },
  { alumnoId: 'a4', inscripcionId: 'i4', nombre: 'Ana Torres Vega', curp: 'BARO880214HSPLNT05', estatus: 'activo' },
  { alumnoId: 'a5', inscripcionId: 'i5', nombre: 'Luisa Martinez Cruz', curp: 'DEXE141015MOCGRN09', estatus: 'activo' },
  { alumnoId: 'a6', inscripcionId: 'i6', nombre: 'Pedro Gomez Ruiz', curp: null, estatus: 'activo' },
  { alumnoId: 'a7', inscripcionId: 'i7', nombre: 'Jose Hernandez Diaz', curp: null, estatus: 'activo' },
  { alumnoId: 'a8', inscripcionId: 'i8', nombre: 'Jose Hernandez Diaz', curp: null, estatus: 'activo' },
]

const DOCUMENTO = [
  registro('Juan Peres Lopes', 'alta', 'JULO100101HDFPRN03'), // 0 identidad por CURP, nombre distinto
  registro('Maria Lopez Garcia', 'alta', 'LOGA120909MVZPQR07'), // 1 CURP faltante en BD
  registro('Carlos Ruiz Mendez', 'alta', 'RUME080505HQRSTN08'), // 2 CURP actual inválida → reparación
  registro('Ana Torres Vega', 'alta', 'ROIS990909HGTSLP01'), // 3 CURP válida contradictoria
  registro('Jose Hernandez Diaz', 'alta', null), // 4 homónimos
  registro('Sofia Ramirez Luna', 'alta', 'VIXO030303MDGLPT06'), // 5 alta con CURP
  registro('Diego Morales Paz', 'alta', null), // 6 alta sin CURP, confianza alta
  // a5 y a6 no aparecen: nunca deben producir una baja.
]

const payload = propuestaDe({ roster: ROSTER, documento: DOCUMENTO, solicitudesBaja: [{ alumnoId: 'a6', inscripcionId: 'i6' }] })!
const ops = payload.operaciones
const opDe = (tipo: string, pred: (o: OperacionPropuestaLista) => boolean) => ops.find((o) => o.tipo === tipo && pred(o))

console.log('\n— Construcción y clasificación —')
verificar(esPayloadPropuestaActualizacionListaValido(payload), '1. La propuesta construida cumple el contrato')
verificar(payload.rosterFingerprint === huella(ROSTER) && payload.grupoId === 'grupo-1' && payload.docenteId === 'docente-1', '1b. Lleva docente, grupo y huella del roster')
verificar(payload.expiraEn === '2026-10-27T15:30:00.000Z', '1c. Vigencia predeterminada de 30 minutos')
verificar(ops.every((o) => o.confirmacion.estado === 'pendiente'), '1d. Toda operación nace pendiente de confirmación')
const nombreA1 = opDe('correccion_nombre', (o) => o.alumnoId === 'a1')
verificar(nombreA1?.clasificacion === 'seguro' && nombreA1.valorPropuesto?.nombre === 'Juan Peres Lopes' && nombreA1.inscripcionId === 'i1', '2. Corrección de nombre con identidad por CURP: segura, con valor actual y propuesto')
const curpA2 = opDe('correccion_curp', (o) => o.alumnoId === 'a2')
verificar(curpA2?.clasificacion === 'seguro' && curpA2.valorActual?.curp === null && curpA2.valorPropuesto?.curp === 'LOGA120909MVZPQR07', '3. CURP faltante (vía segura del plan): segura, valor actual null')
const curpA3 = opDe('correccion_curp', (o) => o.alumnoId === 'a3')
verificar(curpA3?.clasificacion === 'seguro' && curpA3.valorActual?.curp === 'CURPINVALIDA', '4. Reparación de CURP inválida (vía segura del plan): segura, valor actual RAW')
const altaSofia = opDe('alta', (o) => o.valorPropuesto?.nombre === 'Sofia Ramirez Luna')
verificar(altaSofia?.clasificacion === 'seguro' && altaSofia.alumnoId === null && altaSofia.valorPropuesto?.curp === 'VIXO030303MDGLPT06', '5. Alta con CURP verificable: segura, sin alumnoId (nunca reutiliza historial)')
const altaDiego = opDe('alta', (o) => o.valorPropuesto?.nombre === 'Diego Morales Paz')
verificar(
  altaDiego?.clasificacion === 'requiere_revision' && altaDiego.motivos.includes('ALTA_SIN_CURP_VERIFICABLE') && altaDiego.evidencia.nombreConfianza === 'alta',
  '6. Confianza alta de lectura NO autoriza: alta sin CURP requiere revisión'
)
verificar(!ops.some((o) => o.alumnoId === 'a5'), '7. Un alumno ausente en la foto no genera ninguna operación (nunca baja inferida)')
const bajaA6 = opDe('baja', (o) => o.alumnoId === 'a6')
verificar(
  bajaA6?.clasificacion === 'seguro' && bajaA6.inscripcionId === 'i6' && bajaA6.confirmacion.individual && bajaA6.evidencia.fuente === 'solicitud_docente',
  '8. Baja solo por solicitud explícita: identifica alumno e inscripción y exige autorización individual'
)
verificar(ops.filter((o) => o.tipo === 'baja').length === 1, '8b. La única baja es la solicitada')

console.log('\n— CURP contradictorias y nombres ambiguos —')
const curpA4 = opDe('correccion_curp', (o) => o.alumnoId === 'a4')
verificar(curpA4?.clasificacion === 'bloqueado' && curpA4.motivos[0] === 'CURP_CONTRADICTORIA', '9. CURP válida guardada vs. otra CURP válida leída: bloqueada, nunca se sobrescribe')
const ambiguo = opDe('registro_sin_resolver', (o) => o.evidencia.indiceRegistro === 4)
verificar(ambiguo?.clasificacion === 'bloqueado' && ambiguo.motivos[0] === 'IDENTIDAD_AMBIGUA' && ambiguo.alumnoId === null, '10. Nombre ambiguo (homónimos): bloqueado sin alumno asignado')
{
  const p = propuestaDe({ roster: ROSTER, documento: [registro('Ana Torres Vega', 'alta', 'DEXE141015MOCGRN09')] })!
  verificar(p.operaciones[0].tipo === 'registro_sin_resolver' && p.operaciones[0].motivos[0] === 'CURP_DE_OTRO_ALUMNO', '11. CURP leída que pertenece a otro alumno del grupo: bloqueada')
}
{
  const p = propuestaDe({ roster: ROSTER, documento: [registro('Ana Torres Vegaa', 'alta', 'ROIS990909HGTSLP01')] })!
  const op = p.operaciones.find((o) => o.alumnoId === 'a4' && o.tipo === 'correccion_curp')
  verificar(op?.clasificacion === 'bloqueado', '11b. Contradicción de CURP también bloqueada cuando la identidad es solo aproximada')
  const nom = p.operaciones.find((o) => o.alumnoId === 'a4' && o.tipo === 'correccion_nombre')
  verificar(nom?.clasificacion === 'requiere_revision' && nom.motivos.includes('IDENTIDAD_NO_CONFIRMADA_POR_CURP'), '11c. Corrección de nombre con identidad aproximada: requiere revisión')
}
{
  const p = propuestaDe({ roster: ROSTER, documento: [registro('Maria Lopez Garcia', 'alta', 'LOGA120909MVZPQR07', false, 'media')] })!
  verificar(p.operaciones[0].tipo === 'correccion_curp' && p.operaciones[0].clasificacion === 'requiere_revision' && p.operaciones[0].motivos.includes('LECTURA_DUDOSA'), '12. CURP ilegible: requiere revisión')
}

console.log('\n— Altas duplicadas —')
{
  const p = propuestaDe({
    roster: ROSTER,
    documento: [registro('Elena Ruiz Soto', 'alta', 'VIXO030303MDGLPT06'), registro('Elena Ruiz Soto', 'alta', 'VIXO030303MDGLPT06'), registro('Elena Ruis Soto', 'alta', null)],
  })!
  const altas = p.operaciones.filter((o) => o.tipo === 'alta')
  verificar(altas.filter((o) => o.clasificacion === 'bloqueado' && o.motivos[0] === 'ALTA_DUPLICADA_EN_DOCUMENTO').length === 2, '13. Dos altas iguales en el documento: ambas bloqueadas, sin elegir una')
  verificar(new Set(p.operaciones.map((o) => o.operacionId)).size === p.operaciones.length, '13b. Identificadores únicos aun con registros idénticos')
}
{
  const p = propuestaDe({ roster: ROSTER, documento: [registro('Nombre Distinto Total', 'alta', 'JULO100101HDFPRN03')] })!
  verificar(!p.operaciones.some((o) => o.tipo === 'alta'), '14. CURP ya inscrita en el grupo: nunca se propone como alta (se asocia al alumno existente)')
}
{
  const p = propuestaDe({ roster: ROSTER, documento: [registro('Pedro Gomez Ruiz', 'alta', null)] })
  verificar(p === null, '15. Alumno ya inscrito por nombre, sin cambios: no hay alta ni propuesta')
}

console.log('\n— Bajas —')
{
  const p = propuestaDe({
    roster: ROSTER,
    documento: [],
    solicitudesBaja: [
      { alumnoId: 'zz', inscripcionId: 'izz' },
      { alumnoId: 'a5', inscripcionId: 'i-otro-grupo' },
      { alumnoId: 'a6', inscripcionId: 'i6' },
      { alumnoId: 'a6', inscripcionId: 'i6' },
      { alumnoId: 'a6', inscripcionId: 'i7' },
    ],
  })!
  const motivos = p.operaciones.map((o): string => o.motivos[0] ?? 'seguro')
  verificar(motivos[0] === 'BAJA_ALUMNO_NO_IDENTIFICADO', '16. Baja de un alumno que no está en el grupo: bloqueada')
  verificar(motivos[1] === 'BAJA_INSCRIPCION_NO_CORRESPONDE', '17. Baja con inscripción de otro grupo: bloqueada')
  verificar(motivos.length === 4 && motivos[2] === 'seguro', '18. Solicitud de baja idéntica repetida: cuenta una sola vez')
  verificar(motivos[3] === 'SOLICITUD_BAJA_DUPLICADA', '18b. Otra solicitud de baja para el mismo alumno: bloqueada')
}
{
  const inactivo = ROSTER.map((a) => (a.alumnoId === 'a6' ? { ...a, estatus: 'baja' } : a))
  const p = propuestaDe({ roster: inactivo, documento: [], solicitudesBaja: [{ alumnoId: 'a6', inscripcionId: 'i6' }] })!
  verificar(p.operaciones[0].motivos[0] === 'BAJA_INSCRIPCION_NO_ACTIVA', '19. Baja de una inscripción ya no activa: bloqueada')
}
{
  // Manipulación: convertir una operación del documento en baja.
  const falso = structuredClone(payload)
  const op = falso.operaciones.find((o) => o.tipo === 'correccion_curp')!
  Object.assign(op, { tipo: 'baja', valorActual: { estatus: 'activo' }, valorPropuesto: { estatus: 'baja' }, confirmacion: { estado: 'pendiente', individual: true } })
  verificar(!esPayloadPropuestaActualizacionListaValido(falso), '20. Una baja con evidencia del documento es estructuralmente inválida')
  verificar(lanza(() => firmarPropuestaActualizacionConSecreto(falso, SECRETO), ErrorConstruccionPropuestaLista), '20b. ...y nunca se firma')
}

// ============================================================
// Evaluación de la solicitud de aplicación
// ============================================================

const sobre = firmarPropuestaActualizacionConSecreto(payload, SECRETO)
const CONTEXTO: ContextoEvaluacionPropuestaLista = {
  docenteId: 'docente-1',
  conversacionId: 'conversacion-1',
  grupoId: 'grupo-1',
  rosterFingerprintActual: huella(ROSTER),
  ahora: new Date('2026-10-27T15:10:00.000Z'),
  propuestaYaAplicada: false,
}
const evaluar = (confirmaciones: unknown, contexto: Partial<ContextoEvaluacionPropuestaLista> = {}, s: unknown = sobre) =>
  evaluarSolicitudAplicacionLista({ sobre: s, secreto: SECRETO, confirmaciones, contexto: { ...CONTEXTO, ...contexto } })
const seguras = ops.filter((o) => o.clasificacion === 'seguro')

console.log('\n— Firma y aplicación válida —')
verificar(verificarPropuestaActualizacionConSecreto(sobre, SECRETO), '21. El sobre firmado verifica')
{
  const r = evaluar(seguras.map((o) => confirmar(o)))
  verificar(r.ok && r.operacionesAutorizadas.length === seguras.length && r.propuestaId === 'propuesta-1', '22. Confirmar individualmente cada operación segura la autoriza')
}
{
  const r = evaluar([confirmar(nombreA1!)])
  verificar(r.ok && r.operacionesAutorizadas.length === 1, '22b. Solo se autoriza lo confirmado; lo demás sigue pendiente')
}
verificar(!evaluar([]).ok && (evaluar([]) as { codigo: string }).codigo === 'SIN_CONFIRMACIONES', '22c. Sin confirmaciones no se autoriza nada')

console.log('\n— Bajas sin autorización —')
{
  const r = evaluar([confirmar(bajaA6!, false)])
  verificar(!r.ok && r.rechazos[0]?.codigo === 'BAJA_SIN_AUTORIZACION_INDIVIDUAL', '23. Baja confirmada sin autorización explícita: rechazada')
  const r2 = evaluar([{ ...confirmar(bajaA6!), alumnoId: 'a5' }])
  verificar(!r2.ok && r2.rechazos[0]?.codigo === 'IDENTIFICACION_NO_CORRESPONDE', '24. Baja con identificación de otro alumno: rechazada')
  const r3 = evaluar([{ ...confirmar(bajaA6!), inscripcionId: 'i5' }])
  verificar(!r3.ok && r3.rechazos[0]?.codigo === 'IDENTIFICACION_NO_CORRESPONDE', '24b. Baja con otra inscripción: rechazada')
  const r4 = evaluar([confirmar(curpA2!, true)])
  verificar(!r4.ok && r4.rechazos[0]?.codigo === 'AUTORIZACION_BAJA_INDEBIDA', '25. Autorización de baja sobre una operación que no es baja: rechazada')
  const r5 = evaluar([confirmar(curpA2!), confirmar(bajaA6!, false)])
  verificar(!r5.ok && r5.rechazos.length === 1, '26. Todo o nada: una confirmación inválida impide autorizar las demás')
}

console.log('\n— Revisión y bloqueos no se aplican —')
{
  const r = evaluar([confirmar(altaDiego!)])
  verificar(!r.ok && r.rechazos[0]?.codigo === 'OPERACION_NO_APLICABLE', '27. Operación que requiere revisión no se puede confirmar')
  const r2 = evaluar([confirmar(ambiguo!)])
  verificar(!r2.ok && r2.rechazos[0]?.codigo === 'OPERACION_NO_APLICABLE', '28. Registro ambiguo no se puede confirmar')
  const r3 = evaluar([{ operacionId: 'no-existe', alumnoId: null, inscripcionId: null, autorizaBaja: false }])
  verificar(!r3.ok && r3.rechazos[0]?.codigo === 'OPERACION_NO_EXISTE', '29. Operación inexistente: rechazada')
  const r4 = evaluar([{ ...confirmar(curpA2!), extra: 1 }])
  verificar(!r4.ok && r4.codigo === 'CONFIRMACIONES_INVALIDAS', '29b. Confirmación con claves extra: rechazada')
}

console.log('\n— Grupo, docente y conversación —')
verificar((evaluar([confirmar(curpA2!)], { grupoId: 'grupo-2' }) as { codigo: string }).codigo === 'GRUPO_NO_CORRESPONDE', '30. Grupo incorrecto: rechazada')
verificar((evaluar([confirmar(curpA2!)], { docenteId: 'docente-2' }) as { codigo: string }).codigo === 'DOCENTE_NO_CORRESPONDE', '31. Otro docente: rechazada')
verificar((evaluar([confirmar(curpA2!)], { conversacionId: 'conversacion-2' }) as { codigo: string }).codigo === 'CONVERSACION_NO_CORRESPONDE', '32. Otra conversación: rechazada')
{
  const rosterMatching = ROSTER.map((a) => ({ id: a.alumnoId, nombre: a.nombre, curp: a.curp }))
  const comparacion = compararListaOficial(DOCUMENTO, rosterMatching)
  const plan = construirPlanDeActualizacionLista({
    grupoId: 'grupo-2', rosterFingerprint: huella(ROSTER), generadoEn: GENERADO_EN, comparacion,
    propuestasReparacionCurp: { candidatos: [], totalCurpDiferente: 0, totalNoAccionables: 0 },
    roster: ROSTER.map((a) => ({ id: a.alumnoId, inscripcionId: a.inscripcionId })),
  })
  verificar(
    lanza(() => construirPropuestaActualizacionLista({ propuestaId: 'p', docenteId: 'd', conversacionId: 'c', grupoId: 'grupo-1', generadoEn: GENERADO_EN, roster: ROSTER, comparacion, plan }), ErrorConstruccionPropuestaLista),
    '33. Un plan de otro grupo no se convierte en propuesta'
  )
}
{
  // Docente con varios grupos: el mismo documento en otro grupo produce
  // operaciones distintas y su sobre no vale en grupo-1.
  const roster2 = ROSTER.map((a) => ({ ...a, inscripcionId: `g2-${a.inscripcionId}` }))
  const p2 = propuestaDe({ grupoId: 'grupo-2', roster: roster2, documento: DOCUMENTO })!
  const ids1 = new Set(ops.map((o) => o.operacionId))
  verificar(p2.operaciones.every((o) => !ids1.has(o.operacionId)), '34. Varios grupos: los identificadores de operación quedan atados al grupo')
  const s2 = firmarPropuestaActualizacionConSecreto(p2, SECRETO)
  verificar((evaluar([confirmar(p2.operaciones[0])], {}, s2) as { codigo: string }).codigo === 'GRUPO_NO_CORRESPONDE', '34b. La propuesta de grupo-2 no se aplica en grupo-1')
}

console.log('\n— Caducidad —')
verificar((evaluar([confirmar(curpA2!)], { ahora: new Date(payload.expiraEn) }) as { codigo: string }).codigo === 'PROPUESTA_CADUCADA', '35. Al llegar a expiraEn: caducada')
verificar(evaluar([confirmar(curpA2!)], { ahora: new Date(Date.parse(payload.expiraEn) - 1) }).ok, '35b. Un milisegundo antes: vigente')
verificar((evaluar([confirmar(curpA2!)], { ahora: new Date('2026-10-27T14:00:00.000Z') }) as { codigo: string }).codigo === 'PROPUESTA_NO_VIGENTE', '36. Generada "en el futuro": rechazada')
verificar(lanza(() => propuestaDe({ roster: ROSTER, documento: DOCUMENTO, vigenciaMinutos: 121 }), ErrorConstruccionPropuestaLista), '37. Vigencia mayor al máximo: no se construye')
{
  const falso = structuredClone(payload)
  falso.expiraEn = '2026-10-28T15:00:00.000Z'
  verificar(!verificarPropuestaActualizacionConSecreto({ payload: falso, firma: sobre.firma }, SECRETO), '38. Extender expiraEn invalida la firma')
}

console.log('\n— Cambios concurrentes —')
{
  const rosterCambiado = ROSTER.map((a) => (a.alumnoId === 'a2' ? { ...a, curp: 'LOGA120909MVZPQR07' } : a))
  verificar((evaluar([confirmar(curpA2!)], { rosterFingerprintActual: huella(rosterCambiado) }) as { codigo: string }).codigo === 'ROSTER_CAMBIO', '39. El roster cambió desde la propuesta: rechazada')
  const rosterConAlta = [...ROSTER, { alumnoId: 'a9', inscripcionId: 'i9', nombre: 'Nuevo Alumno', curp: null, estatus: 'activo' }]
  verificar((evaluar([confirmar(curpA2!)], { rosterFingerprintActual: huella(rosterConAlta) }) as { codigo: string }).codigo === 'ROSTER_CAMBIO', '39b. Otra alta concurrente en el grupo: rechazada')
  verificar(
    lanza(() => propuestaDe({ roster: rosterCambiado, rosterParaPlan: ROSTER, documento: DOCUMENTO }), ErrorConstruccionPropuestaLista),
    '40. Un plan generado contra un roster anterior no se convierte en propuesta'
  )
}

console.log('\n— Confirmaciones repetidas —')
{
  const r = evaluar([confirmar(curpA2!), confirmar(curpA2!)])
  verificar(!r.ok && r.rechazos[0]?.codigo === 'CONFIRMACION_DUPLICADA', '41. La misma operación confirmada dos veces: rechazada')
  verificar((evaluar([confirmar(curpA2!)], { propuestaYaAplicada: true }) as { codigo: string }).codigo === 'PROPUESTA_YA_APLICADA', '42. Propuesta ya aplicada: rechazada (uso único)')
}

console.log('\n— Integridad, dominio y determinismo —')
{
  const falso = structuredClone(sobre)
  falso.payload.operaciones.find((o) => o.alumnoId === 'a2')!.valorPropuesto = { curp: 'RUME080505HQRSTN08' }
  verificar(!verificarPropuestaActualizacionConSecreto(falso, SECRETO), '43. Cambiar un valor propuesto invalida la propuesta')
  const falso2 = structuredClone(sobre)
  const revision = falso2.payload.operaciones.find((o) => o.clasificacion === 'requiere_revision')!
  Object.assign(revision, { clasificacion: 'seguro', motivos: [] })
  verificar(!verificarPropuestaActualizacionConSecreto(falso2, SECRETO), '44. Subir una operación de revisión a segura invalida la propuesta')
  const falso3 = structuredClone(sobre) as unknown as { payload: Record<string, unknown>; firma: string }
  falso3.payload.extra = 'x'
  verificar(!verificarPropuestaActualizacionConSecreto(falso3, SECRETO), '45. Claves extra: rechazada')
  verificar(!verificarPropuestaActualizacionConSecreto(sobre, 'otro-secreto-ficticio-123'), '46. Otro secreto: rechazada')
  const falso4 = structuredClone(payload)
  ;(falso4.operaciones[0] as unknown as Record<string, unknown>).tipo = 'eliminar_alumno'
  verificar(!esPayloadPropuestaActualizacionListaValido(falso4), '47. No existe operación que elimine alumnos o historial')
}
{
  const historico = firmarConSecreto({ docenteId: 'docente-1', conversacionId: 'conversacion-1', generadoEn: GENERADO_EN, propuesta: [{ alumnoId: 'a2', campo: 'curp', valorPropuesto: 'LOGA120909MVZPQR07' }] }, SECRETO)
  verificar(!verificarPropuestaActualizacionConSecreto(historico, SECRETO), '48. Un sobre histórico (propuestaFirmada) no vale como propuesta de actualización')
  verificar(!verificarConSecreto(sobre, SECRETO), '48b. ...ni a la inversa')
}
{
  const otra = propuestaDe({ roster: [...ROSTER].reverse(), documento: DOCUMENTO, solicitudesBaja: [{ alumnoId: 'a6', inscripcionId: 'i6' }] })!
  const s2 = firmarPropuestaActualizacionConSecreto(otra, SECRETO)
  verificar(otra.rosterFingerprint === payload.rosterFingerprint && s2.firma === sobre.firma, '49. Determinista: mismo resultado y firma aunque cambie el orden del roster')
}
{
  const anterior = process.env.LISTA_OFICIAL_HMAC_SECRET_KEY
  delete process.env.LISTA_OFICIAL_HMAC_SECRET_KEY
  verificar(lanza(() => firmarPropuestaActualizacionLista(payload)), '50. Sin secreto configurado no se firma (fail-closed)')
  if (anterior !== undefined) process.env.LISTA_OFICIAL_HMAC_SECRET_KEY = anterior
}

console.log('\n— Niveles educativos —')
{
  // Preescolar: listas sin CURP; los alumnos ya inscritos no generan nada.
  const roster = [
    { alumnoId: 'k1', inscripcionId: 'ik1', nombre: 'Valeria Soto Rios', curp: null, estatus: 'activo' },
    { alumnoId: 'k2', inscripcionId: 'ik2', nombre: 'Mateo Cruz Lara', curp: null, estatus: 'activo' },
  ]
  verificar(propuestaDe({ roster, documento: [registro('Valeria Soto Rios', 'alta', null), registro('Mateo Cruz Lara', 'alta', null)] }) === null, '51. Preescolar sin CURP y sin cambios: no hay propuesta')
  const p = propuestaDe({ roster, documento: [registro('Regina Paz Mora', 'alta', null)] })!
  verificar(p.operaciones[0].tipo === 'alta' && p.operaciones[0].clasificacion === 'requiere_revision', '51b. Alta sin CURP en preescolar: requiere revisión, nunca se descarta')
}
{
  // Secundaria: formato oficial APELLIDO/APELLIDO*NOMBRE.
  const p = propuestaDe({ roster: ROSTER, documento: [registro('RUIZ/SOTO*ELENA', 'alta', 'VIXO030303MDGLPT06')] })!
  verificar(p.operaciones[0].tipo === 'alta' && p.operaciones[0].motivos.includes('FORMATO_NOMBRE_NO_CONVERTIBLE'), '52. Nombre en formato oficial: no se convierte solo, requiere revisión')
  const q = propuestaDe({ roster: ROSTER, documento: [registro('TORRES/VEGA*ANA', 'alta', 'BARO880214HSPLNT05')] })
  verificar(q === null, '52b. Mismo nombre en formato oficial: no se propone corrección')
}

console.log(`\n${fallos === 0 ? 'Todas las verificaciones pasaron.' : `${fallos} verificación(es) fallaron.`}`)
process.exit(fallos === 0 ? 0 : 1)
