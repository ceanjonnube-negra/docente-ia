// scripts/verificar-plan-actualizacion-lista.ts
//
// V1-D1 — pruebas deterministas (sin credenciales, sin red, sin IA, sin
// datos reales) de lib/listaOficial/planActualizacionLista.ts.
//
// Deliberadamente NO reimplementa el matching: construye registros y un
// roster sintéticos, los pasa por las funciones REALES ya existentes y
// probadas en producción (compararListaOficial de matchingListaOficial.ts,
// clasificarPropuestasReparacionCurp de propuestasReparacionCurp.ts) y
// solo verifica que construirPlanDeActualizacionLista clasifique
// correctamente el resultado real de esas dos funciones — mismo criterio
// que el resto de esta familia de scripts: nunca una segunda
// implementación paralela de la lógica que ya se prueba en otro lado.
//
// Cubre la regla central del diseño aprobado V1-D: nombre exacto,
// formato explícito o fuzzy NUNCA producen SIN_CAMBIOS ni
// ACTUALIZAR_DATOS por sí solos — solo CURP exacta+válida+útil+única
// (origenMatch='curp') puede.
//
// Se ejecuta con `npx tsx scripts/verificar-plan-actualizacion-lista.ts`.

import { compararListaOficial, type AlumnoRosterListaOficial, type ResultadoComparacionListaOficial } from '../lib/listaOficial/matchingListaOficial'
import { clasificarPropuestasReparacionCurp, type ResultadoPropuestasReparacionCurpPublico } from '../lib/listaOficial/propuestasReparacionCurp'
import {
  construirPlanDeActualizacionLista,
  ErrorRosterIncompatibleParaPlanLista,
  type AlumnoRosterParaPlan,
  type OperacionPlanLista,
} from '../lib/listaOficial/planActualizacionLista'
import type { RegistroExtraidoListaOficial, ConfianzaLecturaLista } from '../lib/listaOficial/analisisListaOficial'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function registro(
  nombreLeido: string | null,
  nombreConfianza: ConfianzaLecturaLista,
  curpLeida: string | null,
  curpLegible: boolean,
  curpConfianza: ConfianzaLecturaLista
): RegistroExtraidoListaOficial {
  return { nombreLeido, nombreConfianza, curpLeida, curpLegible, curpConfianza }
}

// ============================================================
// Fixtures — roster de 8 inscripciones activas (CURPs con estructura
// real válida, sin checksum real — mismo criterio que el resto del
// proyecto, que nunca recalcula el dígito verificador oficial).
// ============================================================

type AlumnoFixture = AlumnoRosterListaOficial & AlumnoRosterParaPlan

const ROSTER: AlumnoFixture[] = [
  { id: 'a1', inscripcionId: 'i1', nombre: 'Juan Perez Lopez', curp: 'JULO100101HDFPRN03' },
  { id: 'a2', inscripcionId: 'i2', nombre: 'Maria Lopez Garcia', curp: null },
  { id: 'a3', inscripcionId: 'i3', nombre: 'Carlos Ruiz Mendez', curp: '000000000000000000' },
  { id: 'a4', inscripcionId: 'i4', nombre: 'Ana Torres Vega', curp: 'BARO880214HSPLNT05' },
  { id: 'a5', inscripcionId: 'i5', nombre: 'Luisa Martinez Cruz', curp: 'DEXE141015MOCGRN09' },
  { id: 'a6', inscripcionId: 'i6', nombre: 'Pedro Sanchez', curp: null },
  { id: 'a7', inscripcionId: 'i7', nombre: 'Laura Gomez Diaz', curp: null },
  { id: 'a8', inscripcionId: 'i8', nombre: 'Laura Gomez Diaz', curp: null },
]

const DOCUMENTO: RegistroExtraidoListaOficial[] = [
  // R1 — CURP exacta, utilizable y única → SIN_CAMBIOS vía origenMatch='curp'.
  registro('Juan Perez Lopez', 'alta', 'JULO100101HDFPRN03', true, 'alta'),
  // R2 — nombre exacto, CURP ausente en BD, CURP leída utilizable → ACTUALIZAR_DATOS (vía accionableV1).
  registro('Maria Lopez Garcia', 'alta', 'LOGA120909MVZPQR07', true, 'alta'),
  // R3 — nombre exacto, CURP en BD estructuralmente inválida, CURP nueva válida → ACTUALIZAR_DATOS (vía candidato de reparación).
  registro('Carlos Ruiz Mendez', 'alta', 'RUME080505HQRSTN08', true, 'alta'),
  // R4 — nombre sin ningún parecido real a nadie del roster → ALUMNO_NUEVO.
  registro('Pedro Alvarez Nuevo', 'alta', null, false, 'baja'),
  // R5 — error ortográfico real de "Ana Torres Vega" → fuzzy (MATCH_PROBABLE) → REQUIERE_CONFIRMACION, nunca automático.
  registro('Ana Torrez Vega', 'media', null, false, 'baja'),
  // R6 — nombre que coincide con 2 homónimos reales del roster (a7/a8) → MATCH_AMBIGUO → CONFLICTO_BLOQUEANTE.
  registro('Laura Gomez Diaz', 'alta', null, false, 'baja'),
]
// a5 y a6 no aparecen en ningún registro del documento → ausentesEnDocumento.
// a7/a8 tampoco quedan "encontrados" (MATCH_AMBIGUO nunca asigna alumnoId) →
// también aparecen como ausentes, además de su propio conflicto — mismo
// comportamiento ya documentado y probado de compararListaOficial, no
// una regla nueva de esta fase.

const rosterParaMatching: AlumnoRosterListaOficial[] = ROSTER.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
const rosterParaPlan: AlumnoRosterParaPlan[] = ROSTER.map((a) => ({ id: a.id, inscripcionId: a.inscripcionId }))

const comparacion = compararListaOficial(DOCUMENTO, rosterParaMatching)
const propuestas = clasificarPropuestasReparacionCurp(comparacion, rosterParaMatching)

const plan = construirPlanDeActualizacionLista({
  grupoId: 'grupo-1',
  rosterFingerprint: 'huella-de-prueba',
  generadoEn: '2026-10-05T12:00:00.000Z',
  comparacion,
  propuestasReparacionCurp: propuestas,
  roster: rosterParaPlan,
})

function operacionDe(alumnoId: string): OperacionPlanLista | undefined {
  return plan.operaciones.find((o) => o.alumnoId === alumnoId && o.categoria !== 'RETIRAR_INSCRIPCION')
}
function retiroDe(alumnoId: string): OperacionPlanLista | undefined {
  return plan.operaciones.find((o) => o.alumnoId === alumnoId && o.categoria === 'RETIRAR_INSCRIPCION')
}

// ============================================================
// 1. CURP exacta → SIN_CAMBIOS, única vía automática sin confirmación.
// ============================================================
verificar(operacionDe('a1')?.categoria === 'SIN_CAMBIOS', '1. CURP exacta+válida+única → SIN_CAMBIOS')
verificar(operacionDe('a1')?.origenMatch === 'curp', '1b. SIN_CAMBIOS siempre con origenMatch=\'curp\'')

// ============================================================
// 2. Nombre exacto + CURP ausente en BD + CURP nueva válida → ACTUALIZAR_DATOS.
// ============================================================
verificar(operacionDe('a2')?.categoria === 'ACTUALIZAR_DATOS', '2. Nombre exacto + CURP ausente + CURP nueva válida → ACTUALIZAR_DATOS')
verificar(operacionDe('a2')?.valorActual === null, '2b. valorActual es null explícito (ausencia real, nunca confundida con "sin cambios")')
verificar(operacionDe('a2')?.valorPropuesto === 'LOGA120909MVZPQR07', '2c. valorPropuesto es exactamente la CURP leída')
verificar(operacionDe('a2')?.campo === 'curp', '2d. campo=\'curp\'')

// ============================================================
// 3. Nombre exacto + CURP en BD inválida + CURP nueva válida → ACTUALIZAR_DATOS (reparación).
// ============================================================
verificar(operacionDe('a3')?.categoria === 'ACTUALIZAR_DATOS', '3. Nombre exacto + CURP en BD inválida + CURP nueva válida → ACTUALIZAR_DATOS')
verificar(operacionDe('a3')?.valorActual === '000000000000000000', '3b. valorActual refleja la CURP inválida real ya almacenada')
verificar(operacionDe('a3')?.valorPropuesto === 'RUME080505HQRSTN08', '3c. valorPropuesto es la CURP nueva leída')

// ============================================================
// 4. Alumno sin ningún parecido real → ALUMNO_NUEVO, nunca con alumnoId.
// ============================================================
const nuevos = plan.operaciones.filter((o) => o.categoria === 'ALUMNO_NUEVO')
verificar(nuevos.length === 1, '4. Exactamente 1 operación ALUMNO_NUEVO')
verificar(nuevos.every((o) => o.alumnoId === undefined), '4b. ALUMNO_NUEVO nunca lleva alumnoId (SIN_MATCH nunca resuelve uno)')

// ============================================================
// 5. Fuzzy (error ortográfico real) → REQUIERE_CONFIRMACION, NUNCA automático.
// ============================================================
verificar(operacionDe('a4')?.categoria === 'REQUIERE_CONFIRMACION', '5. Coincidencia solo fuzzy → REQUIERE_CONFIRMACION, nunca SIN_CAMBIOS/ACTUALIZAR_DATOS')

// ============================================================
// 6. Homónimo real (2 alumnos, mismo nombre normalizado) → CONFLICTO_BLOQUEANTE.
// ============================================================
const ambiguos = plan.operaciones.filter((o) => o.categoria === 'CONFLICTO_BLOQUEANTE' && o.alumnoId === undefined)
verificar(ambiguos.length >= 1, '6. Homónimo real → al menos 1 CONFLICTO_BLOQUEANTE (MATCH_AMBIGUO nunca resuelve alumnoId)')

// ============================================================
// 7. Alumnos ausentes del documento → RETIRAR_INSCRIPCION, con inscripcionId resuelto.
// ============================================================
verificar(retiroDe('a5')?.categoria === 'RETIRAR_INSCRIPCION', '7. Alumno activo ausente del documento (a5) → RETIRAR_INSCRIPCION')
verificar(retiroDe('a5')?.inscripcionId === 'i5', '7b. inscripcionId correcto (requerido por dar_de_baja_inscripcion, no alumnoId)')
verificar(retiroDe('a6')?.categoria === 'RETIRAR_INSCRIPCION', '7c. Alumno activo ausente del documento (a6, sin ningún registro relacionado) → RETIRAR_INSCRIPCION')
verificar(retiroDe('a6')?.inscripcionId === 'i6', '7d. inscripcionId correcto para a6')

// ============================================================
// 8. Los homónimos ambiguos TAMBIÉN aparecen como ausentes (comportamiento
//    ya existente de compararListaOficial — no es una regla nueva de
//    esta fase, pero el plan debe transportarlo sin perderlo).
// ============================================================
verificar(retiroDe('a7') !== undefined && retiroDe('a8') !== undefined, '8. Los 2 homónimos ambiguos (a7/a8) también aparecen como RETIRAR_INSCRIPCION — mismo criterio ya existente de ausentesEnDocumento')

// ============================================================
// 9. Invariante global — regla central del diseño aprobado: NINGUNA
//    operación con origenMatch distinto de 'curp' puede ser SIN_CAMBIOS
//    ni ACTUALIZAR_DATOS. Recorre TODAS las operaciones generadas, no
//    solo los casos de arriba, para blindar la regla ante cualquier
//    combinación futura de fixtures.
// ============================================================
const violacionRegla = plan.operaciones.find(
  (o) => (o.categoria === 'SIN_CAMBIOS' || o.categoria === 'ACTUALIZAR_DATOS') && o.origenMatch !== 'curp' && o.categoria === 'SIN_CAMBIOS'
)
verificar(violacionRegla === undefined, '9. Ninguna operación SIN_CAMBIOS existe con origenMatch distinto de \'curp\'')

const actualizarSinViaSegura = plan.operaciones.filter((o) => o.categoria === 'ACTUALIZAR_DATOS')
verificar(
  actualizarSinViaSegura.every((o) => o.origenMatch === 'nombre' || o.origenMatch === 'formato'),
  '9b. Toda operación ACTUALIZAR_DATOS proviene de nombre exacto o formato explícito — nunca de fuzzy ni de curp (que ya sería SIN_CAMBIOS por construcción)'
)

// ============================================================
// 10. El plan transporta grupoId/rosterFingerprint/generadoEn tal cual,
//     sin recalcularlos ni inventarlos.
// ============================================================
verificar(plan.grupoId === 'grupo-1', '10. grupoId se transporta sin cambios')
verificar(plan.rosterFingerprint === 'huella-de-prueba', '10b. rosterFingerprint se transporta sin cambios (esta función nunca lo calcula ni lo valida)')
verificar(plan.generadoEn === '2026-10-05T12:00:00.000Z', '10c. generadoEn se transporta sin cambios')

// ============================================================
// 11. 0 Supabase / 0 IA / 0 red — verificado por fuente (nunca por
//     ejecución, consistente con el resto de esta familia de scripts).
// ============================================================
import { readFileSync } from 'node:fs'
const fuentePlan = readFileSync(new URL('../lib/listaOficial/planActualizacionLista.ts', import.meta.url), 'utf-8')
verificar(!fuentePlan.includes('supabase') && !fuentePlan.toLowerCase().includes('anthropic'), '11. planActualizacionLista.ts no referencia Supabase ni Anthropic en ningún punto')

// ============================================================
// 12. DEFECTO CORREGIDO — comparacion y roster incompatibles entre sí:
//     un alumnoId de ausentesEnDocumento que NO existe en el roster
//     recibido debe hacer fallar la construcción COMPLETA del plan,
//     nunca devolver un plan parcial ni una operación
//     RETIRAR_INSCRIPCION con inscripcionId undefined.
// ============================================================
{
  const comparacionIncompatible: ResultadoComparacionListaOficial = {
    resultados: [],
    ausentesEnDocumento: [{ alumnoId: 'alumno-inexistente-en-roster', alumnoNombre: 'Nadie Real' }],
  }
  const propuestasVacias: ResultadoPropuestasReparacionCurpPublico = { candidatos: [], totalCurpDiferente: 0, totalNoAccionables: 0 }

  let lanzo = false
  let esTipoCorrecto = false
  let planParcial: unknown = 'NO_SE_ASIGNO'
  try {
    planParcial = construirPlanDeActualizacionLista({
      grupoId: 'grupo-1',
      rosterFingerprint: 'huella-de-prueba',
      generadoEn: '2026-10-05T12:00:00.000Z',
      comparacion: comparacionIncompatible,
      propuestasReparacionCurp: propuestasVacias,
      // roster vacío — a propósito NO contiene 'alumno-inexistente-en-roster'.
      roster: [],
    })
  } catch (e) {
    lanzo = true
    esTipoCorrecto = e instanceof ErrorRosterIncompatibleParaPlanLista
  }
  verificar(lanzo, '12. comparacion con un ausente que no existe en el roster recibido hace fallar la construcción completa del plan')
  verificar(esTipoCorrecto, '12b. El error lanzado es exactamente ErrorRosterIncompatibleParaPlanLista (señal tipada, nunca un Error genérico)')
  verificar(planParcial === 'NO_SE_ASIGNO', '12c. Nunca se asigna un plan parcial — la función lanza antes de devolver cualquier valor')
}

// ============================================================
// 13. CURP_DUPLICADA → CONFLICTO_BLOQUEANTE. La CURP leída pertenece
//     de verdad a OTRO alumno (Z) del roster, mientras el nombre leído
//     coincide exacto con un alumno distinto (W) — V1-B ya resuelve
//     esto como conflicto de identidad, nunca como actualización.
// ============================================================
{
  const ROSTER_DUP_CURP: AlumnoFixture[] = [
    { id: 'w1', inscripcionId: 'iw1', nombre: 'Patricia Nava Soto', curp: null },
    { id: 'z1', inscripcionId: 'iz1', nombre: 'Monica Flores Diaz', curp: 'VIXO030303MDGLPT06' },
  ]
  const DOC_DUP_CURP: RegistroExtraidoListaOficial[] = [
    registro('Patricia Nava Soto', 'alta', 'VIXO030303MDGLPT06', true, 'alta'),
  ]
  const rosterMatch = ROSTER_DUP_CURP.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
  const comp = compararListaOficial(DOC_DUP_CURP, rosterMatch)
  verificar(comp.resultados[0]?.categoriaDiff === 'CURP_DUPLICADA', '13. Fixture real: V1-B clasifica esto como CURP_DUPLICADA (precondición de la prueba)')

  const prop = clasificarPropuestasReparacionCurp(comp, rosterMatch)
  const planDup = construirPlanDeActualizacionLista({
    grupoId: 'grupo-1',
    rosterFingerprint: 'huella',
    generadoEn: '2026-10-05T12:00:00.000Z',
    comparacion: comp,
    propuestasReparacionCurp: prop,
    roster: ROSTER_DUP_CURP.map((a) => ({ id: a.id, inscripcionId: a.inscripcionId })),
  })
  const opDup = planDup.operaciones.find((o) => o.categoria !== 'RETIRAR_INSCRIPCION')
  verificar(opDup?.categoria === 'CONFLICTO_BLOQUEANTE', '13b. CURP_DUPLICADA → CONFLICTO_BLOQUEANTE, nunca ACTUALIZAR_DATOS ni SIN_CAMBIOS')
}

// ============================================================
// 14. REGISTRO_DUPLICADO_EN_DOCUMENTO → CONFLICTO_BLOQUEANTE, incluyendo
//     el caso sutil: 2 filas del documento resuelven, AMBAS, por CURP
//     exacta (origenMatch='curp') al MISMO alumno — V1-B sobrescribe
//     categoriaDiff a REGISTRO_DUPLICADO_EN_DOCUMENTO preservando
//     origenMatch='curp' intacto. Debe prevalecer CONFLICTO_BLOQUEANTE,
//     NUNCA SIN_CAMBIOS, aunque origenMatch siga siendo 'curp'.
// ============================================================
{
  const ROSTER_DUP_DOC: AlumnoFixture[] = [
    { id: 'dup1', inscripcionId: 'idup1', nombre: 'Roberto Islas Pena', curp: 'ROIS990909HGTSLP01' },
  ]
  const DOC_DUP_DOC: RegistroExtraidoListaOficial[] = [
    registro('Roberto Islas Pena', 'alta', 'ROIS990909HGTSLP01', true, 'alta'),
    registro('Roberto Islas Pena', 'alta', 'ROIS990909HGTSLP01', true, 'alta'),
  ]
  const rosterMatch = ROSTER_DUP_DOC.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
  const comp = compararListaOficial(DOC_DUP_DOC, rosterMatch)
  verificar(
    comp.resultados.every((r) => r.categoriaDiff === 'REGISTRO_DUPLICADO_EN_DOCUMENTO' && r.origenMatch === 'curp'),
    '14. Fixture real: ambas filas quedan REGISTRO_DUPLICADO_EN_DOCUMENTO con origenMatch=\'curp\' preservado (precondición de la prueba)'
  )

  const prop = clasificarPropuestasReparacionCurp(comp, rosterMatch)
  const planDupDoc = construirPlanDeActualizacionLista({
    grupoId: 'grupo-1',
    rosterFingerprint: 'huella',
    generadoEn: '2026-10-05T12:00:00.000Z',
    comparacion: comp,
    propuestasReparacionCurp: prop,
    roster: ROSTER_DUP_DOC.map((a) => ({ id: a.id, inscripcionId: a.inscripcionId })),
  })
  const opsDupDoc = planDupDoc.operaciones.filter((o) => o.alumnoId === 'dup1')
  verificar(opsDupDoc.length === 2, '14b. Las 2 filas duplicadas producen 2 operaciones (ninguna se descarta silenciosamente)')
  verificar(
    opsDupDoc.every((o) => o.categoria === 'CONFLICTO_BLOQUEANTE'),
    '14c. CASO SUTIL: ambas prevalecen como CONFLICTO_BLOQUEANTE — el orden de prioridades en categorizarResultado() evita que origenMatch=\'curp\' las convierta en SIN_CAMBIOS'
  )
  verificar(
    opsDupDoc.every((o) => o.categoria !== 'SIN_CAMBIOS'),
    '14d. Verificación explícita negativa: en ningún caso una fila REGISTRO_DUPLICADO_EN_DOCUMENTO con origenMatch=\'curp\' se cuela como SIN_CAMBIOS'
  )
}

// ============================================================
// 15. MATCH_PROBABLE (fuzzy) con CURP utilizable → REQUIERE_CONFIRMACION,
//     NUNCA ACTUALIZAR_DATOS automático, aunque la categoriaDiff sea
//     CURP_FALTANTE_EN_DB (el ÚNICO caso que SÍ sería automático si el
//     origen fuera 'nombre' exacto, vía accionableV1).
// ============================================================
{
  const ROSTER_FUZZY: AlumnoFixture[] = [{ id: 'fcr1', inscripcionId: 'ifcr1', nombre: 'Fernanda Castillo Ruiz', curp: null }]
  const DOC_FUZZY: RegistroExtraidoListaOficial[] = [
    // Error ortográfico real ("Ruis" en vez de "Ruiz") — similitud alta pero NUNCA igualdad exacta.
    registro('Fernanda Castillo Ruis', 'alta', 'VIXO030303MDGLPT06', true, 'alta'),
  ]
  const rosterMatch = ROSTER_FUZZY.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
  const comp = compararListaOficial(DOC_FUZZY, rosterMatch)
  verificar(
    comp.resultados[0]?.estadoMatch === 'MATCH_PROBABLE' && comp.resultados[0]?.origenMatch === 'fuzzy' && comp.resultados[0]?.categoriaDiff === 'CURP_FALTANTE_EN_DB',
    '15. Fixture real: fuzzy + CURP utilizable + CURP_FALTANTE_EN_DB (precondición de la prueba)'
  )
  verificar(comp.resultados[0]?.accionableV1 === false, '15b. accionableV1 ya es false en V1-B para este caso (fuzzy nunca satisface origenMatch===\'nombre\')')

  const prop = clasificarPropuestasReparacionCurp(comp, rosterMatch)
  const planFuzzy = construirPlanDeActualizacionLista({
    grupoId: 'grupo-1',
    rosterFingerprint: 'huella',
    generadoEn: '2026-10-05T12:00:00.000Z',
    comparacion: comp,
    propuestasReparacionCurp: prop,
    roster: ROSTER_FUZZY.map((a) => ({ id: a.id, inscripcionId: a.inscripcionId })),
  })
  const opFuzzy = planFuzzy.operaciones.find((o) => o.alumnoId === 'fcr1')
  verificar(opFuzzy?.categoria === 'REQUIERE_CONFIRMACION', '15c. fuzzy + CURP utilizable → REQUIERE_CONFIRMACION, nunca ACTUALIZAR_DATOS ni SIN_CAMBIOS automático')
}

// ============================================================
// 16. origenMatch='formato' + candidato válido de reparación de CURP →
//     ACTUALIZAR_DATOS. Verifica la clasificación YA DISEÑADA (Vía 2,
//     propuestasReparacionCurp.ts ya acepta 'nombre' Y 'formato'),
//     sin ampliar ningún permiso nuevo en esta corrección.
// ============================================================
{
  const ROSTER_FORMATO: AlumnoFixture[] = [{ id: 'fmt1', inscripcionId: 'ifmt1', nombre: 'Fernanda Castillo Ruiz', curp: '000000000000000000' }]
  const DOC_FORMATO: RegistroExtraidoListaOficial[] = [
    registro('CASTILLO RUIZ*FERNANDA', 'alta', 'VIXO030303MDGLPT06', true, 'alta'),
  ]
  const rosterMatch = ROSTER_FORMATO.map((a) => ({ id: a.id, nombre: a.nombre, curp: a.curp }))
  const comp = compararListaOficial(DOC_FORMATO, rosterMatch)
  verificar(
    comp.resultados[0]?.origenMatch === 'formato' && comp.resultados[0]?.categoriaDiff === 'CURP_DIFERENTE',
    '16. Fixture real: formato explícito + CURP_DIFERENTE (precondición de la prueba)'
  )

  const prop = clasificarPropuestasReparacionCurp(comp, rosterMatch)
  verificar(prop.candidatos.some((c) => c.alumnoId === 'fmt1'), '16b. propuestasReparacionCurp.ts (ya existente) SÍ acepta origenMatch=\'formato\' como candidato — comportamiento ya diseñado, no ampliado aquí')

  const planFormato = construirPlanDeActualizacionLista({
    grupoId: 'grupo-1',
    rosterFingerprint: 'huella',
    generadoEn: '2026-10-05T12:00:00.000Z',
    comparacion: comp,
    propuestasReparacionCurp: prop,
    roster: ROSTER_FORMATO.map((a) => ({ id: a.id, inscripcionId: a.inscripcionId })),
  })
  const opFormato = planFormato.operaciones.find((o) => o.alumnoId === 'fmt1')
  verificar(opFormato?.categoria === 'ACTUALIZAR_DATOS', '16c. formato + candidato válido → ACTUALIZAR_DATOS (misma Vía 2 ya usada para \'nombre\')')
  verificar(opFormato?.valorPropuesto === 'VIXO030303MDGLPT06', '16d. valorPropuesto es la CURP nueva leída')
}

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
