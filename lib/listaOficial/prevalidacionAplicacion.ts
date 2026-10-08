// lib/listaOficial/prevalidacionAplicacion.ts
//
// V1-D2B/V1-D2B2 — lógica PURA (0 Supabase, 0 IA, 0 red, 0 variables de
// entorno, 0 side effects) de prevalidación read-only de cada
// OperacionAplicableListaOficial, contra datos YA CARGADOS por la capa
// HTTP (app/api/importar-alumnos/aplicar-plan/route.ts). Separada
// deliberadamente de esa capa (ver diseño aprobado V1-D2B, sección 15:
// "testabilidad") para poder probar la decisión determinista sin
// credenciales ni red.
//
// *** ADVERTENCIA ARQUITECTÓNICA OBLIGATORIA ***
// Esta prevalidación es fast-fail/UX — NUNCA la barrera transaccional
// definitiva. La futura RPC de aplicación (V1-D2C) deberá volver a
// validar TODO esto (ownership, roster/estado, CAS, duplicados,
// inscripción, estructura de CURP, concurrencia) dentro de su PROPIA
// transacción, exactamente como ya hacen reparar_curp_desde_lista_oficial/
// importar_alumnos_a_grupo/dar_de_baja_inscripcion hoy. Nunca se diseña
// "ya pasó por aquí, por lo tanto la RPC puede confiar" — el único
// propósito de este módulo es dar al docente un error rápido y claro
// ANTES de intentar una escritura real, no sustituir la revalidación
// que la transacción de escritura debe hacer de todas formas.
//
// V1-D2B2 — adaptado al contrato cerrado V1-D2A2 (actualizar_dato,
// alta_persona, alta_inscripcion, baja — ver lib/listaOficial/
// aplicacionFirmada.ts). Ver auditoría de diseño aprobada "persona vs.
// inscripción": el defecto de la ronda anterior (DUPLICATE_ACTIVE_ENROLLMENT
// emitido solo por coincidencia de NOMBRE, sin haber consultado jamás
// `inscripciones`) queda eliminado por completo — alta_persona ya NUNCA
// examina nombre para decidir duplicado; ese código se reserva
// exclusivamente para alta_inscripcion, y solo después de comprobar
// read-only una inscripción ACTIVA real.
//
// Reutiliza, nunca reimplementa: validarEstructuraCurp (lib/
// motorContexto.ts) — mismo patrón ya usado por corregir-curp/route.ts
// para la validación estructural de CURP del lado servidor en
// TypeScript (existe en código, no solo en SQL, así que reusarla aquí
// no introduce una segunda implementación divergente).

import type { OperacionAplicableListaOficial } from './aplicacionFirmada'
import { validarEstructuraCurp } from '../motorContexto'

// 'IDENTITY_CONFLICT' deliberadamente NO existe en este conjunto — ver
// diseño aprobado V1-D2B2, sección 11: toda ambigüedad de identidad
// (homónimo, CURP dudosa, persona que podría-o-no ser la misma) debe
// resolverse ANTES de firmar el sobre, en el futuro "productor del
// sobre"/enriquecimiento cross-roster — nunca aquí. D2B solo recibe
// operaciones YA inequívocas; los únicos problemas que puede encontrar
// a esta altura son de INTEGRIDAD DE DATOS comprobable read-only
// (duplicado real, CAS obsoleto, estructura inválida, ownership), cada
// uno con su propio código ya existente — ninguno necesita una
// semántica adicional de "conflicto de identidad".
// V1-D2C1-B4A — ACTIVE_ENROLLMENT_IN_OTHER_GROUP es DELIBERADAMENTE
// distinto de ACTIVE_ENROLLMENT_EXISTS: el primero significa "ya activo
// en el grupo DESTINO firmado" (alta_inscripcion no tiene sentido ahí);
// el segundo significa "activo en OTRO grupo del mismo ciclo" (un
// traslado real, no una alta_inscripcion simple). Nunca se fusionan en
// un solo código — un futuro consumidor (UI/Chat IA) necesita poder
// distinguir "ya está aquí" de "está en otro grupo, usa traslado" sin
// adivinar a partir de un mensaje de texto. Esta fase NUNCA convierte
// automáticamente este caso en una operación de traslado — solo
// rechaza con un código estable; la variante 'traslado' todavía no
// existe en el contrato (ver auditoría V1-D2C1-B4, fuera de alcance
// aquí).
export type CodigoErrorPrevalidacion =
  | 'OWNERSHIP_MISMATCH'
  | 'STALE_CURRENT_VALUE'
  | 'DUPLICATE_CURP'
  | 'ACTIVE_ENROLLMENT_EXISTS'
  | 'ACTIVE_ENROLLMENT_IN_OTHER_GROUP'
  | 'INVALID_OPERATION'

export type ResultadoPrevalidacionOperacion =
  | { ok: true; operacion: OperacionAplicableListaOficial }
  | { ok: false; operacion: OperacionAplicableListaOficial; codigo: CodigoErrorPrevalidacion }

// Semántica EXACTA de IS NOT DISTINCT FROM (Postgres) para 2 valores
// string|null en JavaScript: === ya es null-safe para esta unión
// (null === null es true; null === 'x' es false; 'x' === 'x' es true)
// — nunca normalizado, nunca trim/toUpperCase. Exportada y nombrada
// explícitamente (en vez de usar === suelto en cada sitio) para que
// quede documentada y sea probable de forma aislada — ver diseño
// aprobado V1-D2B, sección 10.
export function valoresCurpCoincidenRaw(valorEnBd: string | null, valorEsperado: string | null): boolean {
  return valorEnBd === valorEsperado
}

// Único punto que decide si una CURP (RAW, tal como la propuso el
// sobre firmado) es estructuralmente válida — SOLO para el fast-fail
// de esta capa; reutiliza validarEstructuraCurp real, nunca reinventa
// sus reglas. Mismo criterio que corregir-curp/route.ts: se normaliza
// una COPIA únicamente para esta llamada (validarEstructuraCurp exige
// un valor ya en mayúsculas/sin bordes), el valor original nunca se
// reemplaza en ningún otro punto.
function curpEstructuralmenteValida(curp: string): boolean {
  return validarEstructuraCurp(curp.trim().toUpperCase()).valido
}

// --- Datos minimos YA CARGADOS por el llamador — esta función nunca
// consulta Supabase ni decide qué consultar; solo interpreta lo que ya
// se le entregó.

// Compartida por actualizar_dato (lee curpActual para el CAS) Y
// alta_inscripcion (solo necesita confirmar existencia/ownership/
// institución — curpActual simplemente no se usa en esa rama). Debe
// existir ÚNICAMENTE si el llamador ya confirmó alumnos.docente_id =
// auth.user.id — esta función nunca repite esa comprobación, confía
// en el contrato del llamador (ver route.ts).
export type AlumnoActualCargado = {
  curpActual: string | null
  institucionId: string
}

export type InscripcionActualCargada = {
  alumnoId: string
  grupoId: string
  // V1-D2C1-B4B — ciclo escolar REAL de esta inscripción (derivado de
  // la fila real, nunca recalculado) — necesario para que 'traslado'
  // pueda comparar el ciclo de la inscripción de ORIGEN contra el
  // ciclo del grupo DESTINO (ctx.cicloEscolarId). Las demás
  // operaciones (baja) nunca lo usan — campo adicional inofensivo para
  // ellas, no un cambio de su comportamiento.
  cicloEscolarId: string
  estatus: string
}

export type ContextoPrevalidacion = {
  grupoId: string
  // institución real del grupo YA validado (nunca aceptada del
  // cliente) — ancla para la comprobación cruzada de abajo y para que
  // el alcance de curpsVisiblesDocente quede documentado sin
  // ambigüedad.
  institucionId: string
  // V1-D2C1-B4B — ciclo escolar REAL del grupo DESTINO (grupoId),
  // derivado server-side del grupo ya validado (nunca aceptado del
  // cliente) — mismo patrón que institucionId. Usado exclusivamente
  // por 'traslado' para comparar contra el ciclo real de la
  // inscripción de origen; ninguna otra operación lo necesita.
  cicloEscolarId: string
  // alumnoId -> true si tiene una inscripción ACTIVA en grupoId (ya
  // resuelto por el llamador vía el mismo roster usado para el
  // fingerprint — nunca una segunda fuente de verdad del roster).
  // DOBLE USO deliberado (V1-D2B2): para actualizar_dato confirma
  // pertenencia real a ESTE grupo; para alta_inscripcion, su sola
  // presencia ES la señal de ACTIVE_ENROLLMENT_EXISTS — nunca se
  // introduce una segunda estructura ni una segunda consulta para
  // decir lo mismo dos veces.
  alumnoIdsEnRosterActivo: ReadonlySet<string>
  // V1-D2C1-B4A — alumnoId -> true si tiene una inscripción ACTIVA real
  // en un grupo DISTINTO de grupoId (el destino firmado), dentro del
  // MISMO ciclo escolar que ese grupo destino. Calculado por el
  // llamador con una consulta batch separada (nunca mezclada con
  // alumnoIdsEnRosterActivo, que es estrictamente "activo en ESTE
  // grupo"). Solo tiene sentido consultarlo para alumnoId referenciados
  // por alta_inscripcion — el llamador puede omitir alumnoId que no
  // aparezcan en ninguna operación de ese tipo.
  //
  // LÍMITE DE VISIBILIDAD RLS, documentado explícitamente (igual que
  // curpsVisiblesDocente abajo): esta señal se calcula con auth.supabase
  // (cliente RLS-scoped) — la política real de `inscripciones` solo
  // expone filas de grupos que pertenecen (o están compartidos vía
  // docente_grupos) al docente autenticado. Por tanto, la AUSENCIA de
  // un alumnoId en este conjunto NUNCA demuestra que esa persona no
  // tenga una inscripción activa en un grupo de OTRO docente, incluso
  // de la MISMA institución — solo que, entre lo visible para ESTE
  // docente, no se encontró ninguna. Esta prevalidación nunca presenta
  // esa ausencia como una garantía global; es exclusivamente una señal
  // fast-fail dentro de lo observable hoy. La garantía institucional
  // completa (cross-docente) sigue pendiente de la futura RPC/mecanismo
  // ya identificado en auditorías previas (V1-D2C1-B0), fuera de
  // alcance de esta corrección.
  alumnoIdsActivosEnOtroGrupoMismoCiclo: ReadonlySet<string>
  // alumnoId -> datos reales ya cargados, para TODO alumnoId
  // referenciado por una operación actualizar_dato O alta_inscripcion
  // (unión precargada en una sola consulta batch por el llamador) —
  // SOLO para alumnos cuyo ownership (docente_id) ya fue confirmado.
  // Una operación cuyo alumnoId no aparezca aquí se trata como
  // OWNERSHIP_MISMATCH, nunca como "no encontrado todavía".
  alumnosCargados: ReadonlyMap<string, AlumnoActualCargado>
  // inscripcionId -> fila real ya cargada, mismo criterio de ownership.
  inscripcionesCargadas: ReadonlyMap<string, InscripcionActualCargada>
  // curpNormalizada (trim+mayúsculas) -> TODOS los alumnoId que esta
  // consulta pudo OBSERVAR con esa CURP — ver auditoría aprobada
  // "focalizada ACTIVE_ENROLLMENT_EXISTS/privacidad CURP": el llamador
  // (route.ts) ejecuta esa consulta con auth.supabase (cliente
  // RLS-scoped del docente autenticado), y la policy real de `alumnos`
  // ("Docentes ven sus alumnos", FOR ALL, docente_id=auth.uid())
  // restringe el resultado, SIEMPRE, a filas del propio docente —
  // incluso cuando la consulta además filtra por institucion_id. Por
  // tanto este mapa NUNCA representa "toda la institución": representa
  // únicamente las CURP de alumnos VISIBLES PARA ESTE DOCENTE dentro de
  // la institución destino. Es una PREVALIDACIÓN fast-fail —
  // DUPLICATE_CURP aquí significa que YA se encontró un conflicto real
  // entre las filas visibles; su AUSENCIA nunca demuestra que la CURP
  // esté libre en toda la institución. La garantía institucional
  // completa es responsabilidad EXCLUSIVA de la futura RPC de
  // aplicación (V1-D2C), que deberá revalidarla server-side, dentro de
  // su propia transacción, con un mecanismo autorizado que sí vea más
  // allá de esta RLS (igual que hoy ya hacen importar_alumnos_a_grupo/
  // reparar_curp_desde_lista_oficial) — D2B nunca es la autoridad final
  // de unicidad de CURP, solo un fast-fail de UX. DELIBERADAMENTE un
  // array/lista, nunca un solo string: si 2+ alumnos visibles ya
  // comparten la misma CURP (el esquema real no lo impide —
  // alumnos.curp no tiene UNIQUE), un Map que sobrescribiera con el
  // último visto ocultaría ese conflicto según el orden de llegada de
  // las filas — ver auditoría aprobada "riesgo Map.set/CURP duplicada".
  // Acumular en lista (nunca sobrescribir) hace que la detección de
  // duplicado sea indiferente al orden.
  curpsVisiblesDocente: ReadonlyMap<string, readonly string[]>
}

function error(operacion: OperacionAplicableListaOficial, codigo: CodigoErrorPrevalidacion): ResultadoPrevalidacionOperacion {
  return { ok: false, operacion, codigo }
}
function exito(operacion: OperacionAplicableListaOficial): ResultadoPrevalidacionOperacion {
  return { ok: true, operacion }
}

function prevalidarActualizarDato(
  op: Extract<OperacionAplicableListaOficial, { tipo: 'actualizar_dato' }>,
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion {
  const alumno = ctx.alumnosCargados.get(op.alumnoId)
  // Ownership (ya confirmado por el llamador al construir
  // alumnosCargados) Y pertenencia real a ESTE grupo específico (mismo
  // criterio que GROUP_NOT_AUTHORIZED en reparar_curp_desde_lista_oficial
  // — un alumno real del docente pero sin inscripción activa en el
  // grupo firmado tampoco es accionable aquí).
  if (!alumno || !ctx.alumnoIdsEnRosterActivo.has(op.alumnoId)) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  // Defensa en profundidad: el alumno cargado debe pertenecer a la
  // MISMA institución que el grupo ya validado — nunca debería
  // divergir dado cómo se crean hoy alumnos/grupos (institucion_id se
  // deriva siempre del grupo, ver importar_alumnos_a_grupo.sql), pero
  // esta función nunca asume una invariante de otra tabla sin
  // verificarla.
  if (alumno.institucionId !== ctx.institucionId) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  // CAS — RAW, nunca normalizado.
  if (!valoresCurpCoincidenRaw(alumno.curpActual, op.valorActual)) {
    return error(op, 'STALE_CURRENT_VALUE')
  }
  // Estructura de la CURP nueva — fast-fail reutilizando
  // validarEstructuraCurp real (nunca reinventada). La estructura de la
  // CURP ACTUAL (si inválida, requisito de reparación) y el resto de
  // reglas de negocio quedan exclusivamente para la futura RPC, igual
  // que hoy hace reparar_curp_desde_lista_oficial.
  if (!curpEstructuralmenteValida(op.valorPropuesto)) {
    return error(op, 'INVALID_OPERATION')
  }
  // Duplicado ENTRE LAS FILAS VISIBLES para este docente (ver comentario
  // de curpsVisiblesDocente, arriba — bajo RLS, nunca "toda la
  // institución" realmente). `propietarios` puede tener 0, 1 o más
  // entradas — se excluye ÚNICAMENTE al propio alumno de esta operación
  // (una operación nunca es "duplicada de sí misma"); si queda al menos
  // UN propietario distinto después de excluirlo — incluso si el
  // propio alumno también aparece junto a otros— es un duplicado real
  // y visible, y bloquea; nunca se oculta por quedar "también" en la
  // lista. La AUSENCIA de propietarios aquí nunca demuestra que la
  // CURP esté libre en toda la institución — solo que, entre lo
  // visible para este docente, no hay conflicto.
  const propietarios = ctx.curpsVisiblesDocente.get(op.valorPropuesto.trim().toUpperCase()) ?? []
  const propietariosDistintos = propietarios.filter((id) => id !== op.alumnoId)
  if (propietariosDistintos.length > 0) {
    return error(op, 'DUPLICATE_CURP')
  }
  return exito(op)
}

// V1-D2B2 — alta_persona: crea SIEMPRE una persona nueva, nunca
// reutiliza ni fusiona historial (ver diseño aprobado V1-D2A2). Por
// diseño explícito, esta función NUNCA examina nombre para decidir
// duplicado: una coincidencia de nombre NO es identidad y NO debe
// bloquear ni condicionar un alta_persona — ver auditoría aprobada
// "persona vs. inscripción", sección 5. El posible UNIQUE
// (nombre, docente_id) del esquema real sigue pendiente de verificación
// directa contra el catálogo (fuera de esta capa); esta función
// deliberadamente NO inventa una regla de identidad basada en nombre
// para compensar esa incertidumbre — si esa restricción existe y
// bloquea un homónimo real, esa es una limitación de esquema que se
// audita y corrige por separado, nunca aquí.
function prevalidarAltaPersona(
  op: Extract<OperacionAplicableListaOficial, { tipo: 'alta_persona' }>,
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion {
  if (op.curp === null) {
    return exito(op)
  }
  if (!curpEstructuralmenteValida(op.curp)) {
    return error(op, 'INVALID_OPERATION')
  }
  // alta_persona nunca tiene un alumnoId propio que excluir (todavía no
  // existe la persona) — CUALQUIER propietario VISIBLE de esta CURP (1
  // o más, ver comentario de curpsVisiblesDocente) es un conflicto
  // real: esta CURP ya está asignada a alguien que este docente puede
  // ver, nunca se crea una persona nueva con ella. Su ausencia aquí NO
  // demuestra que la CURP esté libre en toda la institución — solo
  // fast-fail dentro de lo visible; la garantía institucional completa
  // es responsabilidad de la futura D2C.
  const propietarios = ctx.curpsVisiblesDocente.get(op.curp.trim().toUpperCase()) ?? []
  if (propietarios.length > 0) {
    return error(op, 'DUPLICATE_CURP')
  }
  return exito(op)
}

// V1-D2B2 — alta_inscripcion: crea ÚNICAMENTE una inscripción nueva
// para una persona que YA EXISTE y cuya identidad ya fue resuelta con
// certeza antes de firmar (ver diseño aprobado V1-D2A2). Esta función
// NUNCA decide identidad — solo confirma, read-only, que el alumnoId
// ya firmado sigue siendo real, del docente autenticado, de la misma
// institución que el grupo destino, y que NO existe ya una inscripción
// ACTIVA equivalente (alumno_id + grupo_id, ver auditoría aprobada
// sección 7: grupo_id ya determina un único ciclo_escolar_id en el
// esquema real — ciclo_escolar_id de una inscripción siempre se deriva
// del grupo al crearla, nunca diverge — así que comprobar por grupo_id
// ya es equivalente a comprobar por grupo_id+ciclo_escolar_id, sin
// necesitar ese campo por separado).
//
// V1-D2C1-B4A — además, nunca debe resultar en una SEGUNDA inscripción
// activa del mismo alumno en el MISMO ciclo escolar pero OTRO grupo
// (el índice parcial real inscripciones_alumno_ciclo_activo_uk lo
// impediría en la escritura real de todas formas — ver auditoría
// V1-D2C1-B2/B3 — pero esta prevalidación lo adelanta con un código
// claro, nunca dejando que ese choque ocurra como un error crudo de
// base de datos). Nunca convierte este caso en un traslado automático
// — solo rechaza; esa operación todavía no existe en este contrato.
function prevalidarAltaInscripcion(
  op: Extract<OperacionAplicableListaOficial, { tipo: 'alta_inscripcion' }>,
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion {
  const alumno = ctx.alumnosCargados.get(op.alumnoId)
  if (!alumno) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  if (alumno.institucionId !== ctx.institucionId) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  // ctx.alumnoIdsEnRosterActivo ya es, por construcción (ver
  // comentario de ContextoPrevalidacion), el conjunto de alumnoId con
  // una inscripción ACTIVA real en este grupoId — su sola presencia
  // aquí ES la comprobación de "ya existe una inscripción activa
  // equivalente". Un alumno ausente de este conjunto puede tener 0
  // inscripciones o únicamente históricas/baja en este grupo — en
  // AMBOS casos alta_inscripcion sigue siendo válida (nunca se
  // reactiva una inscripción de baja; la futura escritura crea una
  // fila nueva).
  if (ctx.alumnoIdsEnRosterActivo.has(op.alumnoId)) {
    return error(op, 'ACTIVE_ENROLLMENT_EXISTS')
  }
  // V1-D2C1-B4A — ya no está activo en ESTE grupo, pero SÍ en otro
  // grupo del mismo ciclo (dato ya cargado por el llamador, read-only,
  // nunca una segunda decisión de identidad): esto nunca se resuelve
  // como un alta_inscripcion simple — requeriría cerrar la inscripción
  // anterior primero, usando la operación distinta 'traslado' (ver
  // prevalidarTraslado más abajo, V1-D2C1-B4B) — alta_inscripcion NUNCA
  // hace ese cierre por su cuenta, ni sugiere ni ejecuta un traslado
  // automáticamente. Rechazar aquí con un código estable y específico
  // es más seguro que dejar que la futura escritura real choque contra
  // el índice parcial de unicidad (inscripciones_alumno_ciclo_activo_uk)
  // con un error crudo — ese índice sigue siendo la barrera DEFINITIVA
  // hasta que exista la RPC transaccional de aplicación; esta
  // prevalidación solo adelanta el mismo resultado con un mensaje claro.
  if (ctx.alumnoIdsActivosEnOtroGrupoMismoCiclo.has(op.alumnoId)) {
    return error(op, 'ACTIVE_ENROLLMENT_IN_OTHER_GROUP')
  }
  return exito(op)
}

function prevalidarBaja(
  op: Extract<OperacionAplicableListaOficial, { tipo: 'baja' }>,
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion {
  const inscripcion = ctx.inscripcionesCargadas.get(op.inscripcionId)
  // Ownership (ya confirmado por el llamador) + que de verdad
  // corresponda al alumno y al grupo firmados — dar_de_baja_inscripcion
  // real NO recibe alumnoId como parámetro (solo p_inscripcion_id), así
  // que esta comprobación de alumnoId es defensa en profundidad de esta
  // capa, nunca un requisito que la RPC real imponga por su cuenta.
  if (!inscripcion || inscripcion.alumnoId !== op.alumnoId || inscripcion.grupoId !== ctx.grupoId) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  if (inscripcion.estatus !== 'activo') {
    return error(op, 'STALE_CURRENT_VALUE')
  }
  return exito(op)
}

// V1-D2C1-B4B — traslado: cierra una inscripción ACTIVA de ORIGEN
// (inscripcionIdOrigen, en un grupo distinto del destino) y, en una
// fase posterior (la futura RPC transaccional, todavía inexistente),
// abre una inscripción nueva en el grupo DESTINO ya firmado
// (ctx.grupoId). Esta función NUNCA decide identidad ni decide
// automáticamente que un traslado es procedente — el alumnoId y la
// inscripcionIdOrigen ya llegan resueltos e inequívocos desde antes de
// firmar (misma regla que alta_inscripcion/baja). Reutiliza
// EXCLUSIVAMENTE códigos de error ya existentes (OWNERSHIP_MISMATCH,
// STALE_CURRENT_VALUE, INVALID_OPERATION, ACTIVE_ENROLLMENT_EXISTS) —
// 0 código nuevo, porque cada fallo de traslado es, en esencia, el
// mismo tipo de fallo que ya existe para baja/alta_inscripcion,
// aplicado a la inscripción de origen o al grupo destino.
function prevalidarTraslado(
  op: Extract<OperacionAplicableListaOficial, { tipo: 'traslado' }>,
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion {
  // Alumno — existente, visible, autorizado, misma institución que el
  // grupo destino (mismo criterio que actualizar_dato/alta_inscripcion).
  const alumno = ctx.alumnosCargados.get(op.alumnoId)
  if (!alumno) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }
  if (alumno.institucionId !== ctx.institucionId) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }

  // Inscripción de ORIGEN — existente, visible (ya cargada por el
  // llamador con ownership confirmado, mismo criterio que
  // prevalidarBaja) y correspondiente EXACTAMENTE al alumnoId firmado
  // — nunca se confía en inscripcionIdOrigen por sí solo.
  const origen = ctx.inscripcionesCargadas.get(op.inscripcionIdOrigen)
  if (!origen || origen.alumnoId !== op.alumnoId) {
    return error(op, 'OWNERSHIP_MISMATCH')
  }

  // Forma de la solicitud — un traslado real exige que el grupo de
  // ORIGEN sea DISTINTO del grupo DESTINO firmado (si coincidieran, no
  // hay ningún traslado real que ejecutar — esto no es una baja ni una
  // reactivación) y que ambos pertenezcan al MISMO ciclo escolar (un
  // traslado entre ciclos distintos queda fuera de alcance de esta
  // operación, por diseño — ver auditoría V1-D2C1-B4). Ambas
  // condiciones son sobre la FORMA de la solicitud, independientes de
  // si la inscripción de origen sigue activa en este instante — se
  // comprueban antes del estado mutable, igual que primero se confirma
  // identidad antes de comprobar un CAS.
  if (origen.grupoId === ctx.grupoId) {
    return error(op, 'INVALID_OPERATION')
  }
  if (origen.cicloEscolarId !== ctx.cicloEscolarId) {
    return error(op, 'INVALID_OPERATION')
  }

  // Estado — la inscripción de origen debe seguir activa AHORA (fail-
  // closed ante reintentos/concurrencia, mismo criterio que
  // prevalidarBaja: una inscripción ya dada de baja nunca se
  // reprocesa en silencio).
  if (origen.estatus !== 'activo') {
    return error(op, 'STALE_CURRENT_VALUE')
  }

  // Destino — igual que alta_inscripcion: ctx.alumnoIdsEnRosterActivo
  // ya es, por construcción, el conjunto de alumnoId con una
  // inscripción ACTIVA real en ESTE grupo (el destino). Su presencia
  // aquí significa que ya existe una inscripción activa equivalente en
  // destino — un traslado nunca debe crear una segunda.
  if (ctx.alumnoIdsEnRosterActivo.has(op.alumnoId)) {
    return error(op, 'ACTIVE_ENROLLMENT_EXISTS')
  }

  return exito(op)
}

// Punto único de entrada — recorre TODAS las operaciones y se detiene
// en la PRIMERA que falle (mismo principio "TODO o NADA" que regirá la
// futura RPC transaccional: no tiene sentido reportar qué otras
// operaciones también fallarían si la primera ya impide continuar).
// 0 Supabase, 0 IA, 0 red — puro, determinista, probable sin
// credenciales.
export function prevalidarOperaciones(
  operaciones: readonly OperacionAplicableListaOficial[],
  ctx: ContextoPrevalidacion
): ResultadoPrevalidacionOperacion[] {
  const resultados: ResultadoPrevalidacionOperacion[] = []
  for (const op of operaciones) {
    if (op.tipo === 'actualizar_dato') {
      resultados.push(prevalidarActualizarDato(op, ctx))
    } else if (op.tipo === 'alta_persona') {
      resultados.push(prevalidarAltaPersona(op, ctx))
    } else if (op.tipo === 'alta_inscripcion') {
      resultados.push(prevalidarAltaInscripcion(op, ctx))
    } else if (op.tipo === 'baja') {
      resultados.push(prevalidarBaja(op, ctx))
    } else if (op.tipo === 'traslado') {
      resultados.push(prevalidarTraslado(op, ctx))
    } else {
      // Inalcanzable: OperacionAplicableListaOficial es una unión
      // discriminada exhaustiva de solo 5 variantes (ver
      // aplicacionFirmada.ts) — este chequeo de tipo (nunca ejecutado
      // en runtime real) hace que agregar una 6ª variante sin manejarla
      // aquí falle en `npx tsc`, no solo en una prueba.
      const _exhaustivo: never = op
      resultados.push(error(_exhaustivo, 'INVALID_OPERATION'))
    }
  }
  return resultados
}

// Primer resultado fallido, o null si todas las operaciones son
// válidas — helper mínimo para la capa HTTP (fail-fast: la respuesta
// de error reporta exactamente 1 motivo, nunca una lista completa de
// fallas de otras operaciones del mismo lote).
export function primerFallo(resultados: readonly ResultadoPrevalidacionOperacion[]): ResultadoPrevalidacionOperacion | null {
  return resultados.find((r) => !r.ok) ?? null
}
