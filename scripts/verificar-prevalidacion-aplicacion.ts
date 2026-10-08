// scripts/verificar-prevalidacion-aplicacion.ts
//
// V1-D2B/V1-D2B2 — pruebas deterministas (sin credenciales, sin red,
// sin Supabase, sin IA) de la lógica PURA de prevalidación
// (lib/listaOficial/prevalidacionAplicacion.ts), adaptada al contrato
// cerrado V1-D2A2 (actualizar_dato, alta_persona, alta_inscripcion,
// baja). La capa HTTP (app/api/importar-alumnos/aplicar-plan/route.ts)
// no se prueba aquí — el repositorio no tiene un patrón de tests HTTP
// sin escribir BD, y esta ronda no introduce uno nuevo. Varios casos
// HTTP-level (docente distinto, fingerprint igual/distinto, sobre
// inválido) ya están exhaustivamente cubiertos por otras suites
// (52 pruebas de V1-D2A/V1-D2A2; 17 pruebas de V1-D1) — se documenta
// cada caso explícitamente en vez de duplicar cobertura ya real.
//
// Se ejecuta con `npx tsx scripts/verificar-prevalidacion-aplicacion.ts`.

import {
  prevalidarOperaciones,
  primerFallo,
  valoresCurpCoincidenRaw,
  type ContextoPrevalidacion,
  type AlumnoActualCargado,
  type InscripcionActualCargada,
} from '../lib/listaOficial/prevalidacionAplicacion'
import type {
  OperacionAplicableListaOficial,
  OperacionActualizarDatoAplicable,
  OperacionAltaPersonaAplicable,
  OperacionAltaInscripcionAplicable,
  OperacionBajaAplicable,
  OperacionTrasladoAplicable,
} from '../lib/listaOficial/aplicacionFirmada'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

// ============================================================
// CAS — valoresCurpCoincidenRaw. Sin cambios respecto a V1-D2B.
// ============================================================
verificar(valoresCurpCoincidenRaw(null, null), '1. CAS null/null coincide')
verificar(!valoresCurpCoincidenRaw(null, 'JULO100101HDFPRN03'), '2. CAS null (BD) / string (esperado) NO coincide')
verificar(!valoresCurpCoincidenRaw('JULO100101HDFPRN03', null), '3. CAS string (BD) / null (esperado) NO coincide')
verificar(valoresCurpCoincidenRaw('JULO100101HDFPRN03', 'JULO100101HDFPRN03'), '4. CAS string exacto coincide')
verificar(!valoresCurpCoincidenRaw('julo100101hdfprn03', 'JULO100101HDFPRN03'), '5. CAS con diferencia de mayúsculas/minúsculas NO coincide (RAW, nunca normalizado)')
verificar(!valoresCurpCoincidenRaw(' JULO100101HDFPRN03', 'JULO100101HDFPRN03'), '6. CAS con diferencia de espacios NO coincide (RAW, nunca normalizado)')

// ============================================================
// Fixtures comunes para prevalidarOperaciones.
// ============================================================
const GRUPO_ID = 'grupo-1'
const INSTITUCION_ID = 'institucion-1'
const CICLO_ID = 'ciclo-2026'

function contextoBase(overrides: Partial<ContextoPrevalidacion> = {}): ContextoPrevalidacion {
  return {
    grupoId: GRUPO_ID,
    institucionId: INSTITUCION_ID,
    cicloEscolarId: CICLO_ID,
    alumnoIdsEnRosterActivo: new Set(['a1']),
    alumnoIdsActivosEnOtroGrupoMismoCiclo: new Set(),
    alumnosCargados: new Map<string, AlumnoActualCargado>([['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: INSTITUCION_ID }]]),
    inscripcionesCargadas: new Map<string, InscripcionActualCargada>([['i1', { alumnoId: 'a1', grupoId: GRUPO_ID, cicloEscolarId: CICLO_ID, estatus: 'activo' }]]),
    curpsVisiblesDocente: new Map<string, readonly string[]>(),
    ...overrides,
  }
}

const OP_ACTUALIZAR: OperacionActualizarDatoAplicable = {
  tipo: 'actualizar_dato',
  alumnoId: 'a1',
  campo: 'curp',
  valorActual: 'JULO100101HDFPRN03',
  valorPropuesto: 'RUME080505HQRSTN08',
}
const OP_ALTA_PERSONA: OperacionAltaPersonaAplicable = { tipo: 'alta_persona', nombre: 'Fernanda Castillo Ruiz', curp: null }
const OP_ALTA_INSCRIPCION: OperacionAltaInscripcionAplicable = { tipo: 'alta_inscripcion', alumnoId: 'a2' }
const OP_BAJA: OperacionBajaAplicable = { tipo: 'baja', alumnoId: 'a1', inscripcionId: 'i1' }
const OP_TRASLADO: OperacionTrasladoAplicable = { tipo: 'traslado', alumnoId: 'a3', inscripcionIdOrigen: 'i-origen' }

function unicoResultado(operaciones: OperacionAplicableListaOficial[], ctx: ContextoPrevalidacion) {
  return prevalidarOperaciones(operaciones, ctx)[0]
}

// ============================================================
// actualizar_dato — sin cambios de comportamiento respecto a V1-D2B;
// las pruebas de DUPLICATE_CURP se adaptan a curpsVisiblesDocente como
// array (nunca un solo propietario).
// ============================================================
{
  const r = unicoResultado([OP_ACTUALIZAR], contextoBase())
  verificar(r.ok === true, '7. actualizar_dato válido (CAS coincide, alumno en roster, CURP nueva estructuralmente válida, sin duplicado) → ok')

  const rOwnership = unicoResultado([OP_ACTUALIZAR], contextoBase({ alumnoIdsEnRosterActivo: new Set() }))
  verificar(!rOwnership.ok && rOwnership.codigo === 'OWNERSHIP_MISMATCH', '8. actualizar_dato cuyo alumnoId no está en el roster activo del grupo → OWNERSHIP_MISMATCH')

  const rSinAlumno = unicoResultado([OP_ACTUALIZAR], contextoBase({ alumnosCargados: new Map() }))
  verificar(!rSinAlumno.ok && rSinAlumno.codigo === 'OWNERSHIP_MISMATCH', '8b. actualizar_dato cuyo alumnoId nunca se cargó (no pertenece al docente) → OWNERSHIP_MISMATCH')

  const rInstitucionDistinta = unicoResultado(
    [OP_ACTUALIZAR],
    contextoBase({ alumnosCargados: new Map([['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: 'otra-institucion' }]]) })
  )
  verificar(!rInstitucionDistinta.ok && rInstitucionDistinta.codigo === 'OWNERSHIP_MISMATCH', '8c. actualizar_dato cuyo alumno pertenece a otra institución que el grupo → OWNERSHIP_MISMATCH')

  const rCasDistinto = unicoResultado([{ ...OP_ACTUALIZAR, valorActual: 'OTRA-CURP-DISTINTA000' }], contextoBase())
  verificar(!rCasDistinto.ok && rCasDistinto.codigo === 'STALE_CURRENT_VALUE', '9. actualizar_dato cuyo valorActual ya no coincide con la BD → STALE_CURRENT_VALUE')

  const rCurpInvalida = unicoResultado([{ ...OP_ACTUALIZAR, valorPropuesto: 'XXX' }], contextoBase())
  verificar(!rCurpInvalida.ok && rCurpInvalida.codigo === 'INVALID_OPERATION', '10. actualizar_dato con valorPropuesto estructuralmente inválido → INVALID_OPERATION (reutiliza validarEstructuraCurp real)')

  const rCurpDuplicada = unicoResultado(
    [OP_ACTUALIZAR],
    contextoBase({ curpsVisiblesDocente: new Map([['RUME080505HQRSTN08', ['otro-alumno']]]) })
  )
  verificar(!rCurpDuplicada.ok && rCurpDuplicada.codigo === 'DUPLICATE_CURP', '11. actualizar_dato cuya CURP nueva ya pertenece a OTRO alumno visible para el docente → DUPLICATE_CURP')

  const rCurpPropia = unicoResultado(
    [OP_ACTUALIZAR],
    contextoBase({ curpsVisiblesDocente: new Map([['RUME080505HQRSTN08', ['a1']]]) })
  )
  verificar(rCurpPropia.ok === true, '11b. actualizar_dato cuya CURP nueva ya le pertenece A SÍ MISMO (reconfirmación) nunca se trata como duplicado')

  // V1-D2B2 — el riesgo "Map.set oculta duplicados preexistentes" ya no
  // puede ocurrir: curpsVisiblesDocente acumula TODOS los propietarios.
  // Si la CURP nueva pertenece a 'a1' (el propio alumno) Y TAMBIÉN a un
  // tercero ('otro-alumno-distinto'), debe bloquear igual — el hecho de
  // que uno de los propietarios sea el propio alumno NUNCA debe ocultar
  // que también existe un conflicto real con otro.
  const rCurpPropiaYAjena = unicoResultado(
    [OP_ACTUALIZAR],
    contextoBase({ curpsVisiblesDocente: new Map([['RUME080505HQRSTN08', ['a1', 'otro-alumno-distinto']]]) })
  )
  verificar(
    !rCurpPropiaYAjena.ok && rCurpPropiaYAjena.codigo === 'DUPLICATE_CURP',
    '11c. actualizar_dato cuya CURP nueva pertenece simultáneamente al propio alumno Y a un tercero → DUPLICATE_CURP (el conflicto real nunca queda oculto por la autoposesión)'
  )
}

// ============================================================
// alta_persona — V1-D2A2/V1-D2B2. NUNCA examina nombre para decidir
// duplicado (ver diseño aprobado, sección 5) — ese defecto de la ronda
// anterior (DUPLICATE_ACTIVE_ENROLLMENT por coincidencia de nombre) se
// elimina por completo: el tipo ContextoPrevalidacion ya ni siquiera
// tiene un campo de nombres.
// ============================================================
{
  const rCurpNull = unicoResultado([OP_ALTA_PERSONA], contextoBase())
  verificar(rCurpNull.ok === true, '12. alta_persona válida con curp null → ok')

  const rCurpLibre = unicoResultado([{ ...OP_ALTA_PERSONA, curp: 'RUME080505HQRSTN08' }], contextoBase())
  verificar(rCurpLibre.ok === true, '13. alta_persona válida con CURP estructuralmente válida y libre (0 propietarios) → ok')

  const rCurpInvalida = unicoResultado([{ ...OP_ALTA_PERSONA, curp: 'XXX' }], contextoBase())
  verificar(!rCurpInvalida.ok && rCurpInvalida.codigo === 'INVALID_OPERATION', '14. alta_persona con curp estructuralmente inválida → INVALID_OPERATION')

  const rCurpUsada = unicoResultado(
    [{ ...OP_ALTA_PERSONA, curp: 'RUME080505HQRSTN08' }],
    contextoBase({ curpsVisiblesDocente: new Map([['RUME080505HQRSTN08', ['otro-alumno']]]) })
  )
  verificar(!rCurpUsada.ok && rCurpUsada.codigo === 'DUPLICATE_CURP', '15. alta_persona con CURP que ya pertenece a un alumno visible para el docente (entre las filas precargadas) → DUPLICATE_CURP (alta_persona nunca tiene alumnoId propio que excluir)')

  // Múltiples propietarios visibles de la misma CURP entre las filas
  // precargadas (anomalía de datos real, ya documentada — alumnos.curp
  // no tiene UNIQUE) no deben quedar ocultos: cualquier cantidad >0 ya
  // bloquea. Esto demuestra un conflicto VISIBLE para el docente — no
  // afirma nada sobre cuántos propietarios existan en el resto de la
  // institución, invisibles bajo RLS.
  const rCurpMultiplesPropietarios = unicoResultado(
    [{ ...OP_ALTA_PERSONA, curp: 'RUME080505HQRSTN08' }],
    contextoBase({ curpsVisiblesDocente: new Map([['RUME080505HQRSTN08', ['alumno-x', 'alumno-y']]]) })
  )
  verificar(
    !rCurpMultiplesPropietarios.ok && rCurpMultiplesPropietarios.codigo === 'DUPLICATE_CURP',
    '16. alta_persona con una CURP que ya tiene 2 propietarios visibles para el docente (anomalía real entre las filas precargadas) → DUPLICATE_CURP, ninguno de los 2 queda oculto'
  )

  // Coincidencia de nombre NUNCA produce ACTIVE_ENROLLMENT_EXISTS (ni
  // ningún otro código): no existe ningún campo en ContextoPrevalidacion
  // para comparar nombres — estructuralmente no puede bloquear por eso.
  const rNombreCoincide = unicoResultado([{ ...OP_ALTA_PERSONA, nombre: 'Cualquier Nombre Que Coincida Con Alguien' }], contextoBase())
  verificar(
    rNombreCoincide.ok === true,
    '17. alta_persona nunca se bloquea por coincidencia de nombre — no existe ningún campo de nombres en el contexto que pueda producir ACTIVE_ENROLLMENT_EXISTS ni ningún otro código'
  )

  // tipo:'alta' (protocolo antiguo, pre-V1-D2A2) — bypass deliberado de
  // tipos para demostrar que el fallback defensivo lo rechaza.
  const operacionTipoAntiguo = { tipo: 'alta', nombre: 'Fernanda Castillo Ruiz', curp: null } as unknown as OperacionAplicableListaOficial
  const rTipoAntiguo = unicoResultado([operacionTipoAntiguo], contextoBase())
  verificar(
    !rTipoAntiguo.ok && rTipoAntiguo.codigo === 'INVALID_OPERATION',
    '18. tipo:\'alta\' (la forma ANTIGUA, pre-V1-D2A2) se rechaza por el fallback defensivo — ya no es una variante reconocida del contrato'
  )
}

// ============================================================
// alta_inscripcion — V1-D2A2/V1-D2B2, variante nueva. Reutiliza
// alumnoIdsEnRosterActivo (ya calculado para el fingerprint) como única
// señal de "ya tiene inscripción activa en este grupo" — 0 consulta
// adicional.
// ============================================================
{
  // Alumno existente/autorizado, SIN inscripción activa (no está en
  // alumnoIdsEnRosterActivo) → válida.
  const ctxConAlumnoSinInscripcion = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([
      ['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: INSTITUCION_ID }],
      ['a2', { curpActual: null, institucionId: INSTITUCION_ID }],
    ]),
  })
  const rValida = unicoResultado([OP_ALTA_INSCRIPCION], ctxConAlumnoSinInscripcion)
  verificar(rValida.ok === true, '19. alta_inscripcion de un alumno existente/autorizado SIN inscripción activa en este grupo → ok')

  // Mismo caso, pero el alumno tiene ÚNICAMENTE inscripciones
  // históricas/baja (no afecta alumnoIdsEnRosterActivo en absoluto,
  // mismo código exacto que "sin ninguna inscripción") — explícito para
  // demostrar que nunca se confunde con "ya activa".
  const ctxConSoloHistorica = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([['a2', { curpActual: null, institucionId: INSTITUCION_ID }]]),
    inscripcionesCargadas: new Map<string, InscripcionActualCargada>([['i-vieja', { alumnoId: 'a2', grupoId: GRUPO_ID, cicloEscolarId: CICLO_ID, estatus: 'baja' }]]),
  })
  const rSoloHistorica = unicoResultado([OP_ALTA_INSCRIPCION], ctxConSoloHistorica)
  verificar(rSoloHistorica.ok === true, '20. alta_inscripcion de un alumno con ÚNICAMENTE inscripciones históricas/baja en este grupo → sigue siendo válida (nunca se reactiva, la futura escritura crea una fila nueva)')

  // Alumno inexistente/no autorizado (nunca cargado) → OWNERSHIP_MISMATCH.
  const rInexistente = unicoResultado([OP_ALTA_INSCRIPCION], contextoBase({ alumnosCargados: new Map() }))
  verificar(!rInexistente.ok && rInexistente.codigo === 'OWNERSHIP_MISMATCH', '21. alta_inscripcion de un alumno inexistente/no autorizado (nunca cargado) → OWNERSHIP_MISMATCH')

  // Alumno real pero de OTRA institución (defensa en profundidad, mismo
  // criterio que actualizar_dato 8c).
  const rOtraInstitucion = unicoResultado(
    [OP_ALTA_INSCRIPCION],
    contextoBase({ alumnosCargados: new Map([['a2', { curpActual: null, institucionId: 'otra-institucion' }]]) })
  )
  verificar(!rOtraInstitucion.ok && rOtraInstitucion.codigo === 'OWNERSHIP_MISMATCH', '22. alta_inscripcion de un alumno de OTRA institución distinta del grupo destino → OWNERSHIP_MISMATCH')

  // Inscripción ACTIVA real → ACTIVE_ENROLLMENT_EXISTS. Reutiliza 'a1'
  // (ya presente en alumnoIdsEnRosterActivo del contexto base).
  const rYaActiva = unicoResultado([{ tipo: 'alta_inscripcion', alumnoId: 'a1' }], contextoBase())
  verificar(!rYaActiva.ok && rYaActiva.codigo === 'ACTIVE_ENROLLMENT_EXISTS', '23. alta_inscripcion de un alumno con inscripción ACTIVA real en este grupo → ACTIVE_ENROLLMENT_EXISTS (comprobado read-only, nunca asumido)')

  // Varias operaciones alta_inscripcion se resuelven con datos
  // precargados, SIN depender del orden — una válida y una inválida en
  // cualquier orden deben resolver igual cada una por su cuenta.
  const ctxVarias = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([
      ['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: INSTITUCION_ID }],
      ['a2', { curpActual: null, institucionId: INSTITUCION_ID }],
    ]),
  })
  const resultadosOrdenA = prevalidarOperaciones(
    [{ tipo: 'alta_inscripcion', alumnoId: 'a2' }, { tipo: 'alta_inscripcion', alumnoId: 'a1' }],
    ctxVarias
  )
  const resultadosOrdenB = prevalidarOperaciones(
    [{ tipo: 'alta_inscripcion', alumnoId: 'a1' }, { tipo: 'alta_inscripcion', alumnoId: 'a2' }],
    ctxVarias
  )
  verificar(
    resultadosOrdenA[0].ok === true && !resultadosOrdenA[1].ok && resultadosOrdenA[1].codigo === 'ACTIVE_ENROLLMENT_EXISTS',
    '24. Lote de 2 alta_inscripcion (orden A: a2 válida, a1 ya activa) — cada una resuelve correctamente según los datos precargados'
  )
  verificar(
    resultadosOrdenB[0].ok === false && resultadosOrdenB[0].codigo === 'ACTIVE_ENROLLMENT_EXISTS' && resultadosOrdenB[1].ok === true,
    '25. El mismo lote en orden INVERSO (orden B: a1 primero) produce EXACTAMENTE los mismos resultados por operación — ninguna depende de la posición ni del orden de llegada'
  )
}

// ============================================================
// alta_inscripcion — V1-D2C1-B4A: detección de actividad ACTIVA en
// OTRO grupo del mismo ciclo escolar (distinta de ACTIVE_ENROLLMENT_EXISTS,
// que es "ya activo en ESTE grupo destino"). Nunca se confunde con
// traslado automático ni con coincidencia de nombre.
// ============================================================
{
  // Activo en OTRO grupo del mismo ciclo (nunca en el destino) →
  // ACTIVE_ENROLLMENT_IN_OTHER_GROUP, código distinto y específico.
  const ctxActivoEnOtroGrupo = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([['a2', { curpActual: null, institucionId: INSTITUCION_ID }]]),
    alumnoIdsActivosEnOtroGrupoMismoCiclo: new Set(['a2']),
  })
  const rActivoOtroGrupo = unicoResultado([OP_ALTA_INSCRIPCION], ctxActivoEnOtroGrupo)
  verificar(
    !rActivoOtroGrupo.ok && rActivoOtroGrupo.codigo === 'ACTIVE_ENROLLMENT_IN_OTHER_GROUP',
    '25b. alta_inscripcion de un alumno con inscripción ACTIVA real en OTRO grupo del mismo ciclo → ACTIVE_ENROLLMENT_IN_OTHER_GROUP (nunca confundido con ACTIVE_ENROLLMENT_EXISTS)'
  )

  // El código es ESTABLE y DISTINTO del de "activo en este grupo" —
  // nunca se fusionan ni se devuelve el mismo código para ambos casos.
  verificar(
    !rActivoOtroGrupo.ok && rActivoOtroGrupo.codigo !== 'ACTIVE_ENROLLMENT_EXISTS',
    '25c. ACTIVE_ENROLLMENT_IN_OTHER_GROUP es un código distinto de ACTIVE_ENROLLMENT_EXISTS — nunca el mismo valor para "aquí" y "en otro grupo"'
  )

  // Activo en ESTE grupo (alumnoIdsEnRosterActivo) tiene PRIORIDAD
  // sobre "activo en otro grupo" si, por anomalía de datos, ambos
  // conjuntos llegaran a incluir al mismo alumno — el caso real nunca
  // debería darse (un alumno no puede estar activo en 2 grupos del
  // mismo ciclo, el índice parcial lo impide), pero el orden de
  // chequeo queda probado explícitamente, sin asumir esa invariante.
  const ctxAmbosConjuntos = contextoBase({
    alumnoIdsEnRosterActivo: new Set(['a1']),
    alumnoIdsActivosEnOtroGrupoMismoCiclo: new Set(['a1']),
  })
  const rAmbos = unicoResultado([{ tipo: 'alta_inscripcion', alumnoId: 'a1' }], ctxAmbosConjuntos)
  verificar(
    !rAmbos.ok && rAmbos.codigo === 'ACTIVE_ENROLLMENT_EXISTS',
    '25d. Si (por anomalía) un alumno apareciera en ambos conjuntos, ACTIVE_ENROLLMENT_EXISTS (este grupo) se comprueba primero — orden de chequeo explícito, no asumido'
  )

  // Ausencia TOTAL en ambos conjuntos (ningún dato visible de
  // actividad) → sigue siendo válida — la ausencia bajo RLS nunca se
  // trata como bloqueo, solo como "no se encontró evidencia visible".
  const ctxSinNingunaSenal = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([['a2', { curpActual: null, institucionId: INSTITUCION_ID }]]),
    alumnoIdsEnRosterActivo: new Set(),
    alumnoIdsActivosEnOtroGrupoMismoCiclo: new Set(),
  })
  const rSinSenal = unicoResultado([OP_ALTA_INSCRIPCION], ctxSinNingunaSenal)
  verificar(
    rSinSenal.ok === true,
    '25e. Sin ninguna señal visible de actividad (ni en este grupo ni en otro) → válida — la ausencia bajo RLS nunca se interpreta como bloqueo adicional'
  )

  // El rechazo NUNCA se convierte automáticamente en una operación de
  // traslado — el resultado sigue siendo exactamente la MISMA operación
  // alta_inscripcion original, marcada como fallida, nunca sustituida
  // por otro tipo de operación.
  verificar(
    rActivoOtroGrupo.operacion.tipo === 'alta_inscripcion',
    '25f. El rechazo conserva la operación original (tipo alta_inscripcion) — nunca se sustituye ni se reinterpreta automáticamente como traslado'
  )
}

// ============================================================
// baja — sin cambios de comportamiento respecto a V1-D2B.
// ============================================================
{
  const r = unicoResultado([OP_BAJA], contextoBase())
  verificar(r.ok === true, '26. baja correcta (inscripción activa, alumno y grupo coinciden) → ok')

  const rAlumnoIncorrecto = unicoResultado([{ ...OP_BAJA, alumnoId: 'otro-alumno' }], contextoBase())
  verificar(!rAlumnoIncorrecto.ok && rAlumnoIncorrecto.codigo === 'OWNERSHIP_MISMATCH', '27. baja cuyo alumnoId no corresponde a la inscripción real → OWNERSHIP_MISMATCH')

  const rGrupoIncorrecto = unicoResultado(
    [OP_BAJA],
    contextoBase({ inscripcionesCargadas: new Map([['i1', { alumnoId: 'a1', grupoId: 'otro-grupo', cicloEscolarId: CICLO_ID, estatus: 'activo' }]]) })
  )
  verificar(!rGrupoIncorrecto.ok && rGrupoIncorrecto.codigo === 'OWNERSHIP_MISMATCH', '28. baja cuya inscripción pertenece a OTRO grupo distinto del firmado → OWNERSHIP_MISMATCH')

  const rYaInactiva = unicoResultado(
    [OP_BAJA],
    contextoBase({ inscripcionesCargadas: new Map([['i1', { alumnoId: 'a1', grupoId: GRUPO_ID, cicloEscolarId: CICLO_ID, estatus: 'baja' }]]) })
  )
  verificar(!rYaInactiva.ok && rYaInactiva.codigo === 'STALE_CURRENT_VALUE', '29. baja cuya inscripción YA no está activa → STALE_CURRENT_VALUE (nunca se reaplica en silencio)')

  const rSinInscripcion = unicoResultado([OP_BAJA], contextoBase({ inscripcionesCargadas: new Map() }))
  verificar(!rSinInscripcion.ok && rSinInscripcion.codigo === 'OWNERSHIP_MISMATCH', '30. baja cuya inscripción nunca se cargó (no pertenece al docente) → OWNERSHIP_MISMATCH')
}

// ============================================================
// 31. Operación con tipo desconocido — inalcanzable vía el tipo real
//     (OperacionAplicableListaOficial es una unión discriminada
//     exhaustiva de 4 variantes, ver aplicacionFirmada.ts), pero el
//     fallback defensivo de prevalidarOperaciones se confirma aquí con
//     un bypass deliberado del sistema de tipos.
// ============================================================
{
  const operacionImposible = { tipo: 'conflicto', alumnoId: 'a1' } as unknown as OperacionAplicableListaOficial
  const r = unicoResultado([operacionImposible], contextoBase())
  verificar(!r.ok && r.codigo === 'INVALID_OPERATION', '31. Una operación con tipo desconocido (bypass de tipos deliberado) es rechazada por el fallback defensivo → INVALID_OPERATION')
}

// ============================================================
// 32-33. primerFallo — helper de fail-fast de la capa HTTP.
// ============================================================
{
  const resultados = prevalidarOperaciones([OP_ACTUALIZAR, { ...OP_BAJA, alumnoId: 'otro' }, OP_ALTA_PERSONA], contextoBase())
  const fallo = primerFallo(resultados)
  verificar(fallo !== null && !fallo.ok && fallo.operacion.tipo === 'baja', '32. primerFallo devuelve exactamente la PRIMERA operación fallida del lote, no la última ni todas')

  const soloExitos = prevalidarOperaciones([OP_ACTUALIZAR], contextoBase())
  verificar(primerFallo(soloExitos) === null, '33. primerFallo devuelve null cuando todas las operaciones son válidas')
}

// ============================================================
// 34-36. Lote mixto — las 4 variantes conviviendo en un mismo lote.
//        Esta fase nunca escribe (0 Supabase) — "fail-closed" aquí
//        significa exclusivamente que primerFallo reporta la primera
//        operación no aplicable; no existe ningún estado persistente
//        que pueda quedar "parcialmente aplicado", porque D2B no
//        aplica nada en absoluto.
// ============================================================
{
  const ctxMixto = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([
      ['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: INSTITUCION_ID }],
      ['a2', { curpActual: null, institucionId: INSTITUCION_ID }],
    ]),
  })
  const resultadosMixtos = prevalidarOperaciones([OP_ACTUALIZAR, OP_ALTA_PERSONA, OP_ALTA_INSCRIPCION, OP_BAJA], ctxMixto)
  verificar(
    resultadosMixtos.length === 4 && resultadosMixtos.every((r) => r.ok === true),
    '34. Un lote mixto (actualizar_dato + alta_persona + alta_inscripcion + baja), todas válidas, resuelve las 4 como ok de forma independiente'
  )

  const resultadosMixtosConFallo = prevalidarOperaciones(
    [OP_ACTUALIZAR, OP_ALTA_PERSONA, { tipo: 'alta_inscripcion', alumnoId: 'a1' }, OP_BAJA],
    ctxMixto
  )
  verificar(
    resultadosMixtosConFallo[2].ok === false && resultadosMixtosConFallo[2].codigo === 'ACTIVE_ENROLLMENT_EXISTS',
    '35. Dentro de un lote mixto, la operación alta_inscripcion inválida (alumno ya activo) falla con su propio código, sin afectar la evaluación de las demás'
  )
  verificar(
    primerFallo(resultadosMixtosConFallo)?.operacion.tipo === 'alta_inscripcion',
    '36. primerFallo localiza exactamente la operación fallida dentro del lote mixto (fail-closed: 0 operaciones se consideran aplicables si una falla, y esta fase no escribe ninguna de todas formas)'
  )
}

// ============================================================
// traslado — V1-D2C1-B4B. Cierra una inscripción ACTIVA de ORIGEN (en
// un grupo distinto del destino, mismo ciclo) — la futura escritura
// real (RPC transaccional, todavía inexistente) abriría la nueva en el
// grupo destino ya firmado. Reutiliza EXCLUSIVAMENTE códigos de error
// ya existentes.
// ============================================================
{
  const GRUPO_ORIGEN = 'grupo-origen'

  function ctxTraslado(overrides: { origen?: Partial<InscripcionActualCargada>; alumnoId?: string } = {}) {
    const alumnoId = overrides.alumnoId ?? 'a3'
    return contextoBase({
      alumnosCargados: new Map<string, AlumnoActualCargado>([[alumnoId, { curpActual: null, institucionId: INSTITUCION_ID }]]),
      inscripcionesCargadas: new Map<string, InscripcionActualCargada>([
        ['i-origen', { alumnoId: 'a3', grupoId: GRUPO_ORIGEN, cicloEscolarId: CICLO_ID, estatus: 'activo', ...overrides.origen }],
      ]),
    })
  }

  // 37. Traslado válido: origen activo, grupo distinto, mismo ciclo,
  //     sin inscripción activa en destino → ok.
  const rValido = unicoResultado([OP_TRASLADO], ctxTraslado())
  verificar(rValido.ok === true, '37. Traslado válido (origen activo en grupo distinto, mismo ciclo, sin actividad en destino) → ok')

  // 38. Origen inexistente (inscripcionIdOrigen nunca se cargó) → OWNERSHIP_MISMATCH.
  const rOrigenInexistente = unicoResultado(
    [OP_TRASLADO],
    contextoBase({
      alumnosCargados: new Map<string, AlumnoActualCargado>([['a3', { curpActual: null, institucionId: INSTITUCION_ID }]]),
      inscripcionesCargadas: new Map(),
    })
  )
  verificar(!rOrigenInexistente.ok && rOrigenInexistente.codigo === 'OWNERSHIP_MISMATCH', '38. Traslado cuya inscripcionIdOrigen nunca se cargó (no visible/no autorizada) → OWNERSHIP_MISMATCH')

  // 39. Origen inactivo (ya dado de baja) → STALE_CURRENT_VALUE.
  const rOrigenInactivo = unicoResultado([OP_TRASLADO], ctxTraslado({ origen: { estatus: 'baja' } }))
  verificar(!rOrigenInactivo.ok && rOrigenInactivo.codigo === 'STALE_CURRENT_VALUE', '39. Traslado cuya inscripción de origen YA no está activa → STALE_CURRENT_VALUE (nunca se reprocesa en silencio)')

  // 40. Alumno incorrecto: inscripcionIdOrigen pertenece a OTRO alumno
  //     distinto del firmado → OWNERSHIP_MISMATCH.
  const rAlumnoIncorrecto = unicoResultado([OP_TRASLADO], ctxTraslado({ origen: { alumnoId: 'otro-alumno-distinto' } }))
  verificar(!rAlumnoIncorrecto.ok && rAlumnoIncorrecto.codigo === 'OWNERSHIP_MISMATCH', '40. Traslado cuya inscripcionIdOrigen pertenece a OTRO alumno distinto del firmado → OWNERSHIP_MISMATCH')

  // 41. Mismo grupo (origen === destino) → INVALID_OPERATION, nunca un traslado real.
  const rMismoGrupo = unicoResultado([OP_TRASLADO], ctxTraslado({ origen: { grupoId: GRUPO_ID } }))
  verificar(!rMismoGrupo.ok && rMismoGrupo.codigo === 'INVALID_OPERATION', '41. Traslado cuyo grupo de origen coincide con el destino → INVALID_OPERATION (no es un traslado real)')

  // 42. Ciclo escolar distinto → INVALID_OPERATION, fuera de alcance de esta operación.
  const rCicloDistinto = unicoResultado([OP_TRASLADO], ctxTraslado({ origen: { cicloEscolarId: 'ciclo-2024' } }))
  verificar(!rCicloDistinto.ok && rCicloDistinto.codigo === 'INVALID_OPERATION', '42. Traslado entre ciclos escolares distintos → INVALID_OPERATION (un traslado real es siempre dentro del mismo ciclo)')

  // 43. Alumno de OTRA institución (destino no autorizado para este
  //     alumno) → OWNERSHIP_MISMATCH, mismo criterio que las demás operaciones.
  const rOtraInstitucion = unicoResultado(
    [OP_TRASLADO],
    contextoBase({
      alumnosCargados: new Map<string, AlumnoActualCargado>([['a3', { curpActual: null, institucionId: 'otra-institucion' }]]),
      inscripcionesCargadas: new Map<string, InscripcionActualCargada>([
        ['i-origen', { alumnoId: 'a3', grupoId: GRUPO_ORIGEN, cicloEscolarId: CICLO_ID, estatus: 'activo' }],
      ]),
    })
  )
  verificar(!rOtraInstitucion.ok && rOtraInstitucion.codigo === 'OWNERSHIP_MISMATCH', '43. Traslado de un alumno de OTRA institución distinta del grupo destino → OWNERSHIP_MISMATCH (destino no autorizado para este alumno)')

  // 44. Alumno inexistente/no autorizado (nunca cargado) → OWNERSHIP_MISMATCH.
  const rAlumnoInexistente = unicoResultado(
    [OP_TRASLADO],
    contextoBase({
      alumnosCargados: new Map(),
      inscripcionesCargadas: new Map<string, InscripcionActualCargada>([
        ['i-origen', { alumnoId: 'a3', grupoId: GRUPO_ORIGEN, cicloEscolarId: CICLO_ID, estatus: 'activo' }],
      ]),
    })
  )
  verificar(!rAlumnoInexistente.ok && rAlumnoInexistente.codigo === 'OWNERSHIP_MISMATCH', '44. Traslado de un alumno nunca cargado (no pertenece al docente) → OWNERSHIP_MISMATCH')

  // 45. Inscripción ACTIVA ya existente en el DESTINO → ACTIVE_ENROLLMENT_EXISTS
  //     (mismo código que alta_inscripcion para "ya está aquí").
  const rActivaEnDestino = unicoResultado(
    [OP_TRASLADO],
    contextoBase({
      alumnoIdsEnRosterActivo: new Set(['a3']),
      alumnosCargados: new Map<string, AlumnoActualCargado>([['a3', { curpActual: null, institucionId: INSTITUCION_ID }]]),
      inscripcionesCargadas: new Map<string, InscripcionActualCargada>([
        ['i-origen', { alumnoId: 'a3', grupoId: GRUPO_ORIGEN, cicloEscolarId: CICLO_ID, estatus: 'activo' }],
      ]),
    })
  )
  verificar(!rActivaEnDestino.ok && rActivaEnDestino.codigo === 'ACTIVE_ENROLLMENT_EXISTS', '45. Traslado cuyo alumno YA tiene una inscripción activa en el grupo DESTINO → ACTIVE_ENROLLMENT_EXISTS')

  // 46. 'traslado' nunca examina nombre ni similitud — no existe ningún
  //     campo de nombre en OperacionTrasladoAplicable ni en el contexto
  //     que pueda influir en la decisión; esto se confirma
  //     estructuralmente (TypeScript) y en runtime con el caso válido
  //     ya probado en 37, que nunca referenció ningún nombre.
  verificar(
    Object.keys(OP_TRASLADO).sort().join(',') === 'alumnoId,inscripcionIdOrigen,tipo',
    "46. OperacionTrasladoAplicable solo tiene {tipo, alumnoId, inscripcionIdOrigen} — estructuralmente no puede llevar nombre ni ninguna señal de similitud"
  )

  // 47. Lote mixto incluyendo 'traslado' junto con las 4 operaciones
  //     previas, todas válidas → las 5 se resuelven independientemente
  //     (operaciones anteriores sin regresión).
  const ctxMixtoConTraslado = contextoBase({
    alumnosCargados: new Map<string, AlumnoActualCargado>([
      ['a1', { curpActual: 'JULO100101HDFPRN03', institucionId: INSTITUCION_ID }],
      ['a2', { curpActual: null, institucionId: INSTITUCION_ID }],
      ['a3', { curpActual: null, institucionId: INSTITUCION_ID }],
    ]),
    inscripcionesCargadas: new Map<string, InscripcionActualCargada>([
      ['i1', { alumnoId: 'a1', grupoId: GRUPO_ID, cicloEscolarId: CICLO_ID, estatus: 'activo' }],
      ['i-origen', { alumnoId: 'a3', grupoId: GRUPO_ORIGEN, cicloEscolarId: CICLO_ID, estatus: 'activo' }],
    ]),
  })
  const resultadosMixtosConTraslado = prevalidarOperaciones([OP_ACTUALIZAR, OP_ALTA_PERSONA, OP_ALTA_INSCRIPCION, OP_BAJA, OP_TRASLADO], ctxMixtoConTraslado)
  verificar(
    resultadosMixtosConTraslado.length === 5 && resultadosMixtosConTraslado.every((r) => r.ok === true),
    "47. Lote mixto de 5 operaciones (incluyendo 'traslado') todas válidas, resueltas independientemente — 0 regresión en actualizar_dato/alta_persona/alta_inscripcion/baja"
  )
}

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
