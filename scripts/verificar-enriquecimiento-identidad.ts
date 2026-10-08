// scripts/verificar-enriquecimiento-identidad.ts
//
// V1-D2C1-B1 — pruebas deterministas (sin credenciales, sin red, sin
// IA, sin datos reales) de lib/listaOficial/enriquecimientoIdentidad.ts.
//
// Cubre exclusivamente la parte pura (clasificarCandidatosIdentidad) y
// la interpretación de respuestas de Supabase (interpretarRespuestaSupabase,
// también pura) — ninguna prueba aquí se conecta a una base de datos
// real, siguiendo el mismo criterio que el resto de esta familia de
// scripts (verificar-plan-actualizacion-lista.ts, etc.): las funciones
// que sí llaman a Supabase (obtenerAlumnosPropiosConCurp,
// obtenerInscripcionesDeAlumnos) son envoltorios delgados sobre esa
// lógica pura, igual que obtenerRosterConPosicion en rosterGrupo.ts,
// y no se prueban aquí por la misma razón que ese archivo tampoco
// tiene un script dedicado.
//
// Se ejecuta con `npx tsx scripts/verificar-enriquecimiento-identidad.ts`.

import {
  clasificarCandidatosIdentidad,
  interpretarRespuestaSupabase,
  type AlumnoPropioConCurp,
  type InscripcionPropia,
  type DestinoEnriquecimiento,
  type CandidatoIdentidad,
} from '../lib/listaOficial/enriquecimientoIdentidad'
import type { EvidenciaDocumentoAlumnoNuevo } from '../lib/listaOficial/planActualizacionLista'
import type { ConfianzaLecturaLista } from '../lib/listaOficial/analisisListaOficial'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    console.error(`✗ ${mensaje}`)
    fallos++
  }
}

function evidencia(
  nombreLeido: string | null,
  curpLeida: string | null,
  curpLegible: boolean,
  curpConfianza: ConfianzaLecturaLista
): EvidenciaDocumentoAlumnoNuevo {
  return { nombreLeido, curpLeida, curpLegible, curpConfianza }
}

const DESTINO: DestinoEnriquecimiento = { grupoId: 'g-destino', cicloEscolarId: 'ciclo-2026' }

// CURPs con estructura real válida (misma procedencia/criterio que los
// fixtures ya usados en scripts/verificar-plan-actualizacion-lista.ts
// — sin checksum oficial real, igual que el resto del proyecto).
const CURP_A7 = 'ROIS990909HGTSLP01'
const CURP_A1 = 'JULO100101HDFPRN03'
const CURP_A2 = 'LOGA120909MVZPQR07'
const CURP_A3 = 'RUME080505HQRSTN08'
const CURP_A4 = 'BARO880214HSPLNT05'
const CURP_A5 = 'DEXE141015MOCGRN09'
const CURP_A6 = 'VIXO030303MDGLPT06'
const CURP_DUP = 'XEXX000101HDFPRN03'
const CURP_INVALIDA_ESTRUCTURA = '000000000000000000'

// ============================================================
// Lote principal — 1 escenario por índice, cubre: coincidencia única,
// baja histórica, cambio_escuela, activa en otro grupo, no activa en
// otro grupo, otro ciclo, activa en destino, CURP nula. También prueba
// conservación del orden (se verifica cada índice por separado).
// ============================================================
const ALUMNOS_PROPIOS: AlumnoPropioConCurp[] = [
  { id: 'a7', curp: CURP_A7 },
  { id: 'a1', curp: CURP_A1 },
  { id: 'a2', curp: CURP_A2 },
  { id: 'a3', curp: CURP_A3 },
  { id: 'a4', curp: CURP_A4 },
  { id: 'a5', curp: CURP_A5 },
  { id: 'a6', curp: CURP_A6 },
]

const INSCRIPCIONES: InscripcionPropia[] = [
  // a1 — baja histórica, MISMO grupo y MISMO ciclo que el destino.
  { id: 'i-a1', alumnoId: 'a1', grupoId: 'g-destino', cicloEscolarId: 'ciclo-2026', estatus: 'baja' },
  // a2 — cambio_escuela, mismo grupo y mismo ciclo que el destino.
  { id: 'i-a2', alumnoId: 'a2', grupoId: 'g-destino', cicloEscolarId: 'ciclo-2026', estatus: 'cambio_escuela' },
  // a3 — activa en OTRO grupo, mismo ciclo.
  { id: 'i-a3', alumnoId: 'a3', grupoId: 'g-otro-1', cicloEscolarId: 'ciclo-2026', estatus: 'activo' },
  // a4 — NO activa (baja) en OTRO grupo, mismo ciclo.
  { id: 'i-a4', alumnoId: 'a4', grupoId: 'g-otro-2', cicloEscolarId: 'ciclo-2026', estatus: 'baja' },
  // a5 — solo tiene inscripción en OTRO ciclo (no en el destino).
  { id: 'i-a5', alumnoId: 'a5', grupoId: 'g-cualquiera', cicloEscolarId: 'ciclo-2024', estatus: 'activo' },
  // a6 — activa en el MISMO grupo y MISMO ciclo que el destino (caso
  // anómalo defensivo: V1-B debería haber resuelto esto como
  // SIN_CAMBIOS antes de llegar aquí, pero se reporta explícitamente).
  { id: 'i-a6', alumnoId: 'a6', grupoId: 'g-destino', cicloEscolarId: 'ciclo-2026', estatus: 'activo' },
  // a7 — SIN ninguna inscripción visible en absoluto.
]

const EVIDENCIAS_PRINCIPALES: EvidenciaDocumentoAlumnoNuevo[] = [
  evidencia('Persona Siete', CURP_A7, true, 'alta'), // 0 → SIN_INSCRIPCION_VISIBLE_EN_DESTINO
  evidencia('Persona Uno', CURP_A1, true, 'alta'), // 1 → BAJA_HISTORICA_EN_DESTINO
  evidencia('Persona Dos', CURP_A2, true, 'alta'), // 2 → CAMBIO_ESCUELA_EN_DESTINO
  evidencia('Persona Tres', CURP_A3, true, 'alta'), // 3 → ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO
  evidencia('Persona Cuatro', CURP_A4, true, 'alta'), // 4 → NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO
  evidencia('Persona Cinco', CURP_A5, true, 'alta'), // 5 → OTRO_CICLO
  evidencia('Persona Seis', CURP_A6, true, 'alta'), // 6 → ACTIVA_EN_DESTINO
  evidencia('Persona Sin CURP', null, false, 'baja'), // 7 → curpUtilizable=false
]

const resultadosPrincipales = clasificarCandidatosIdentidad(EVIDENCIAS_PRINCIPALES, ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)

function unicoCandidato(idx: number): CandidatoIdentidad | undefined {
  return resultadosPrincipales[idx]?.candidatos[0]
}

verificar(resultadosPrincipales.length === 8, '0. El lote principal produce exactamente 8 resultados, en el mismo orden que las 8 evidencias (conservación del orden)')

verificar(unicoCandidato(0)?.estado === 'SIN_INSCRIPCION_VISIBLE_EN_DESTINO', '1. Coincidencia única sin ninguna inscripción visible → SIN_INSCRIPCION_VISIBLE_EN_DESTINO')
verificar(unicoCandidato(0)?.bloqueadoPorRestriccionCiclo === false, '1b. No bloqueado por restricción de ciclo (no existe fila para ese par alumno+ciclo)')

verificar(unicoCandidato(1)?.estado === 'BAJA_HISTORICA_EN_DESTINO', '2. Baja histórica en el MISMO grupo/ciclo destino → BAJA_HISTORICA_EN_DESTINO')
verificar(unicoCandidato(1)?.bloqueadoPorRestriccionCiclo === true, '2b. Bloqueado por restricción de ciclo (ya existe una fila para ese par)')
verificar(unicoCandidato(1)?.inscripcionId === 'i-a1' && unicoCandidato(1)?.grupoId === 'g-destino', '2c. inscripcionId/grupoId reportados corresponden a la fila real encontrada')

verificar(unicoCandidato(2)?.estado === 'CAMBIO_ESCUELA_EN_DESTINO', '3. cambio_escuela en el MISMO grupo/ciclo destino → CAMBIO_ESCUELA_EN_DESTINO, nunca confundido con BAJA_HISTORICA_EN_DESTINO')
verificar(unicoCandidato(2)?.bloqueadoPorRestriccionCiclo === true, '3b. Bloqueado por restricción de ciclo')

verificar(unicoCandidato(3)?.estado === 'ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', '4. Activa en OTRO grupo, mismo ciclo → ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO')
verificar(unicoCandidato(3)?.bloqueadoPorRestriccionCiclo === true, '4b. Bloqueado por restricción de ciclo')
verificar(unicoCandidato(3)?.grupoId === 'g-otro-1', '4c. grupoId reportado es el grupo REAL donde está activa, no el destino')

verificar(unicoCandidato(4)?.estado === 'NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', '5. Baja en OTRO grupo, mismo ciclo → NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO, nunca clasificada como activa')
verificar(unicoCandidato(4)?.bloqueadoPorRestriccionCiclo === true, '5b. Bloqueado por restricción de ciclo')

verificar(unicoCandidato(5)?.estado === 'OTRO_CICLO', '6. Solo inscripción en un ciclo distinto al destino → OTRO_CICLO')
verificar(unicoCandidato(5)?.bloqueadoPorRestriccionCiclo === false, '6b. NO bloqueado por restricción de ciclo (el par alumno+ciclo-destino está libre)')

verificar(unicoCandidato(6)?.estado === 'ACTIVA_EN_DESTINO', '7. Activa en el MISMO grupo/ciclo destino (caso anómalo defensivo) → ACTIVA_EN_DESTINO, nunca silenciado')
verificar(unicoCandidato(6)?.bloqueadoPorRestriccionCiclo === true, '7b. Bloqueado por restricción de ciclo')

verificar(resultadosPrincipales[7]?.curpUtilizable === false, '8. CURP nula (curpLeida=null) → curpUtilizable=false')
verificar(resultadosPrincipales[7]?.candidatos.length === 0, '8b. candidatos=[] cuando curpUtilizable=false — nunca se intenta ninguna búsqueda')
verificar(resultadosPrincipales[7]?.multiplesCoincidencias === false, '8c. multiplesCoincidencias=false cuando curpUtilizable=false')

// ============================================================
// 9. CURP ilegible (curpLegible=false) → curpUtilizable=false, aunque
//    la CURP leída tenga estructura válida.
// ============================================================
{
  const r = clasificarCandidatosIdentidad(
    [evidencia('Alguien', CURP_A1, false, 'alta')],
    ALUMNOS_PROPIOS,
    INSCRIPCIONES,
    DESTINO
  )
  verificar(r[0]?.curpUtilizable === false, '9. CURP ilegible (curpLegible=false) → curpUtilizable=false')
  verificar(r[0]?.candidatos.length === 0, '9b. candidatos=[] con CURP ilegible')
}

// ============================================================
// 10. Confianza media/baja → curpUtilizable=false (solo 'alta' califica).
// ============================================================
{
  const rMedia = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A1, true, 'media')], ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)
  const rBaja = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A1, true, 'baja')], ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)
  verificar(rMedia[0]?.curpUtilizable === false, '10. Confianza \'media\' → curpUtilizable=false')
  verificar(rBaja[0]?.curpUtilizable === false, '10b. Confianza \'baja\' → curpUtilizable=false')
}

// ============================================================
// 11. CURP estructuralmente inválida (18 caracteres pero no pasa
//     validarEstructuraCurp) → curpUtilizable=false, sin reimplementar
//     la regla (se reutiliza validarEstructuraCurp real, importada).
// ============================================================
{
  const r = clasificarCandidatosIdentidad(
    [evidencia('Alguien', CURP_INVALIDA_ESTRUCTURA, true, 'alta')],
    ALUMNOS_PROPIOS,
    INSCRIPCIONES,
    DESTINO
  )
  verificar(r[0]?.curpUtilizable === false, '11. CURP estructuralmente inválida → curpUtilizable=false')
}

// ============================================================
// 12. Ninguna coincidencia propia — CURP utilizable, estructuralmente
//     válida, pero 0 alumno propio la tiene. candidatos=[] NUNCA debe
//     interpretarse como "CURP libre en la institución" (ver
//     comentario del tipo ResultadoEnriquecimientoAlumnoNuevo).
// ============================================================
{
  const soloOtro: AlumnoPropioConCurp[] = [{ id: 'x', curp: CURP_A7 }]
  const r = clasificarCandidatosIdentidad([evidencia('Nadie Conocido', CURP_A6, true, 'alta')], soloOtro, [], DESTINO)
  verificar(r[0]?.curpUtilizable === true, '12. CURP utilizable y estructuralmente válida se reconoce como tal')
  verificar(r[0]?.candidatos.length === 0, '12b. 0 coincidencia propia → candidatos=[]')
  verificar(r[0]?.multiplesCoincidencias === false, '12c. multiplesCoincidencias=false cuando no hay ningún candidato')
}

// ============================================================
// 13. Dos personas (alumnos propios distintos) con la MISMA CURP
//     normalizada → multiplesCoincidencias=true, AMBAS reportadas,
//     ninguna oculta ni elegida arbitrariamente.
// ============================================================
{
  const dosConMismaCurp: AlumnoPropioConCurp[] = [
    { id: 'dupA', curp: CURP_DUP },
    { id: 'dupB', curp: CURP_DUP },
  ]
  const r = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_DUP, true, 'alta')], dosConMismaCurp, [], DESTINO)
  verificar(r[0]?.multiplesCoincidencias === true, '13. Dos alumnos propios con la misma CURP → multiplesCoincidencias=true')
  verificar(r[0]?.candidatos.length === 2, '13b. Ambos candidatos se reportan, ninguno se descarta')
  verificar(
    new Set(r[0]?.candidatos.map((c) => c.alumnoId)).size === 2 &&
      r[0]?.candidatos.every((c) => c.alumnoId === 'dupA' || c.alumnoId === 'dupB'),
    '13c. Los 2 candidatos corresponden exactamente a dupA y dupB, sin inventar ni fusionar ninguno'
  )
}

// ============================================================
// 14. Normalización mayúsculas/minúsculas — la CURP almacenada en
//     alumnos.curp puede no estar en mayúsculas (importar_alumnos_a_grupo
//     nunca cambia mayúsculas/minúsculas al guardar, ver auditoría
//     V1-D2C1-B0 sección E) — la comparación debe seguir encontrando
//     la coincidencia normalizando ambos lados, nunca filtrando en la
//     base de datos con un operador case-insensitive inexistente.
// ============================================================
{
  const propioMinusculas: AlumnoPropioConCurp[] = [{ id: 'a1-min', curp: CURP_A1.toLowerCase() }]
  const r = clasificarCandidatosIdentidad([evidencia('Persona Uno', CURP_A1, true, 'alta')], propioMinusculas, [], DESTINO)
  verificar(r[0]?.candidatos.length === 1 && r[0]?.candidatos[0]?.alumnoId === 'a1-min', '14. CURP almacenada en minúsculas sigue coincidiendo con la CURP leída en mayúsculas (normalización en memoria, no en la BD)')
}

// ============================================================
// 15. Restricción UNIQUE de ciclo — bloqueadoPorRestriccionCiclo es
//     exactamente true en todos los estados donde ya existe una fila
//     para (alumno_id, ciclo_escolar_id=destino), y exactamente false
//     en los 2 donde no existe ninguna.
// ============================================================
{
  const estadosBloqueados = ['BAJA_HISTORICA_EN_DESTINO', 'CAMBIO_ESCUELA_EN_DESTINO', 'ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', 'NO_ACTIVA_EN_OTRO_GRUPO_MISMO_CICLO', 'ACTIVA_EN_DESTINO']
  const estadosLibres = ['SIN_INSCRIPCION_VISIBLE_EN_DESTINO', 'OTRO_CICLO']
  const candidatosPrincipales = resultadosPrincipales.flatMap((r) => r.candidatos)
  verificar(
    candidatosPrincipales.filter((c) => estadosBloqueados.includes(c.estado)).every((c) => c.bloqueadoPorRestriccionCiclo === true),
    '15. Todos los estados con fila existente en el ciclo destino reportan bloqueadoPorRestriccionCiclo=true'
  )
  verificar(
    candidatosPrincipales.filter((c) => estadosLibres.includes(c.estado)).every((c) => c.bloqueadoPorRestriccionCiclo === false),
    '15b. Los estados sin fila en el ciclo destino reportan bloqueadoPorRestriccionCiclo=false'
  )
}

// ============================================================
// 16. Inscripciones visibles incompletas — un alumno matcheado por
//     CURP cuyas inscripciones reales podrían no ser 100% visibles
//     bajo RLS (ver comentario de cabecera del módulo): la función
//     nunca falla ni asume completitud, solo reporta lo que recibió
//     como SIN_INSCRIPCION_VISIBLE_EN_DESTINO — una observación
//     RLS-scoped, nunca una certeza de que la persona no tiene
//     ninguna inscripción real en absoluto.
// ============================================================
{
  const propio: AlumnoPropioConCurp[] = [{ id: 'visible-incompleto', curp: CURP_A2 }]
  const r = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A2, true, 'alta')], propio, [], DESTINO)
  verificar(r[0]?.candidatos[0]?.estado === 'SIN_INSCRIPCION_VISIBLE_EN_DESTINO', '16. 0 inscripciones recibidas (posible visibilidad RLS incompleta) → SIN_INSCRIPCION_VISIBLE_EN_DESTINO, nunca un error')
}

// ============================================================
// 17. Duplicados anómalos de alumno/ciclo — 2 filas de inscripciones
//     para el MISMO (alumno_id, ciclo_escolar_id=destino), violación
//     real del UNIQUE total (ver V1-D2C1-B0 sección H) que esta
//     función nunca asume imposible: debe reportar ANOMALIA, nunca
//     elegir ninguna de las 2 filas arbitrariamente.
// ============================================================
{
  const propio: AlumnoPropioConCurp[] = [{ id: 'anomalo', curp: CURP_A3 }]
  const dosFilasMismoPar: InscripcionPropia[] = [
    { id: 'i-x1', alumnoId: 'anomalo', grupoId: 'g-destino', cicloEscolarId: 'ciclo-2026', estatus: 'activo' },
    { id: 'i-x2', alumnoId: 'anomalo', grupoId: 'g-otro', cicloEscolarId: 'ciclo-2026', estatus: 'baja' },
  ]
  const r = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A3, true, 'alta')], propio, dosFilasMismoPar, DESTINO)
  verificar(r[0]?.candidatos[0]?.estado === 'ANOMALIA', '17. 2 filas para el mismo (alumno_id, ciclo_escolar_id) → ANOMALIA, nunca se elige una arbitrariamente')
  verificar(r[0]?.candidatos[0]?.bloqueadoPorRestriccionCiclo === true, '17b. ANOMALIA se reporta como bloqueado (fail-closed: nunca se afirma que está libre ante una situación ambigua)')
  verificar(r[0]?.candidatos[0]?.inscripcionId === undefined, '17c. ANOMALIA nunca reporta un inscripcionId (no hay una fila única e inequívoca que señalar)')
}

// ============================================================
// 18. Dos registros documentales idénticos (mismo nombreLeido, misma
//     CURP) dentro del MISMO lote → ambos se clasifican de forma
//     independiente y correcta, sin cruzarse ni compartir estado
//     mutable entre sí.
// ============================================================
{
  const propio: AlumnoPropioConCurp[] = [{ id: 'solo1', curp: CURP_A7 }]
  const evIdenticas: EvidenciaDocumentoAlumnoNuevo[] = [
    evidencia('Mismo Nombre', CURP_A7, true, 'alta'),
    evidencia('Mismo Nombre', CURP_A7, true, 'alta'),
  ]
  const r = clasificarCandidatosIdentidad(evIdenticas, propio, [], DESTINO)
  verificar(r.length === 2, '18. 2 registros documentales idénticos producen 2 resultados, uno por índice')
  verificar(
    JSON.stringify(r[0]) === JSON.stringify(r[1]),
    '18b. Ambos resultados son idénticos entre sí (mismo candidato, mismo estado) — consistente, sin contaminación cruzada'
  )
}

// ============================================================
// 19. Conservación del orden — invertir el orden de las evidencias
//     principales produce resultados invertidos en la misma medida
//     (correspondencia por índice, nunca por valor).
// ============================================================
{
  const invertidas = [...EVIDENCIAS_PRINCIPALES].reverse()
  const rInvertido = clasificarCandidatosIdentidad(invertidas, ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)
  const esperadoInvertido = [...resultadosPrincipales].reverse()
  verificar(
    JSON.stringify(rInvertido) === JSON.stringify(esperadoInvertido),
    '19. Invertir el orden de entrada invierte el orden de salida exactamente — la correspondencia es por índice, nunca por nombre/CURP'
  )
}

// ============================================================
// 20. Determinismo — misma entrada, misma salida, sin aleatoriedad
//     (0 randomUUID, 0 Date.now en esta función pura).
// ============================================================
{
  const r1 = clasificarCandidatosIdentidad(EVIDENCIAS_PRINCIPALES, ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)
  const r2 = clasificarCandidatosIdentidad(EVIDENCIAS_PRINCIPALES, ALUMNOS_PROPIOS, INSCRIPCIONES, DESTINO)
  verificar(JSON.stringify(r1) === JSON.stringify(r2), '20. Misma entrada produce exactamente la misma salida en 2 llamadas independientes')
}

// ============================================================
// 21. Error de consulta — interpretarRespuestaSupabase propaga un
//     error real de Supabase como ERROR_SUPABASE, nunca como un
//     resultado parcial silencioso.
// ============================================================
{
  const r = interpretarRespuestaSupabase({ data: null, error: { message: 'conexión fallida' }, count: null }, 500)
  verificar(r.ok === false, '21. Un error real de Supabase produce ok=false')
  verificar(!r.ok && r.error.tipo === 'ERROR_SUPABASE', '21b. El error se clasifica como ERROR_SUPABASE, no como LIMITE_EXCEDIDO')
}

// ============================================================
// 22. Límite de resultados/paginación — un conteo real (count) mayor
//     al límite seguro se rechaza EXPLÍCITAMENTE, nunca se devuelve la
//     página truncada como si fuera el conjunto completo. count=null
//     (desconocido) se trata con el mismo fail-closed.
// ============================================================
{
  const truncado = interpretarRespuestaSupabase({ data: new Array(500).fill({ id: 'x' }), error: null, count: 600 }, 500)
  verificar(truncado.ok === false, '22. count(600) > límite(500) → ok=false, nunca se acepta la página parcial')
  verificar(!truncado.ok && truncado.error.tipo === 'LIMITE_EXCEDIDO' && truncado.error.total === 600, '22b. El error reporta el total real (600) y el límite (500) para diagnóstico')

  const desconocido = interpretarRespuestaSupabase({ data: [{ id: 'x' }], error: null, count: null }, 500)
  verificar(desconocido.ok === false, '22c. count=null (desconocido) también se rechaza — fail-closed, nunca se asume "no truncado" sin certeza')

  const dentroDelLimite = interpretarRespuestaSupabase({ data: [{ id: 'x' }], error: null, count: 1 }, 500)
  verificar(dentroDelLimite.ok === true, '22d. count(1) dentro del límite(500) → ok=true, el caso normal no se bloquea')
}

// ============================================================
// 23. 0 Supabase / 0 IA en la parte pura — verificado por fuente,
//     mismo criterio que el resto de esta familia de scripts.
// ============================================================
import { readFileSync } from 'node:fs'
const fuente = readFileSync(new URL('../lib/listaOficial/enriquecimientoIdentidad.ts', import.meta.url), 'utf-8')
verificar(!fuente.toLowerCase().includes('anthropic') && !fuente.includes('randomUUID') && !fuente.includes('Date.now'), '23. enriquecimientoIdentidad.ts no referencia IA ni usa randomUUID/Date.now en ningún punto')

// ============================================================
// V1-D2C1-B1 — correcciones de la auditoría mecánica (2 hallazgos
// bloqueantes): interpretación de respuestas Supabase y selección
// arbitraria en OTRO_CICLO. Pruebas A-I pedidas explícitamente para
// cubrir ambos escenarios exactos, antes no probados.
// ============================================================

// ============================================================
// A. data=null, error=null, count=5 → error (nunca "0 filas legítimas").
// ============================================================
{
  const r = interpretarRespuestaSupabase({ data: null, error: null, count: 5 }, 500)
  verificar(r.ok === false, 'A. data=null con error=null y count=5 → ok=false (nunca se convierte silenciosamente en [])')
  verificar(!r.ok && r.error.tipo === 'ERROR_SUPABASE', 'Ab. Se clasifica como ERROR_SUPABASE, no como un resultado vacío exitoso')
}

// ============================================================
// B. data=[], error=null, count=5 → error (0 filas recibidas, pero el
//    conteo real dice que había 5 — inconsistente, nunca se acepta).
// ============================================================
{
  const r = interpretarRespuestaSupabase({ data: [], error: null, count: 5 }, 500)
  verificar(r.ok === false, 'B. data=[] con count=5 → ok=false (0 recibidas ≠ 5 esperadas)')
  verificar(!r.ok && r.error.tipo === 'RESPUESTA_INCONSISTENTE', 'Bb. Se clasifica como RESPUESTA_INCONSISTENTE')
}

// ============================================================
// C. count=5, data.length=4 → error (respuesta incompleta, nunca se
//    acepta como si fuera el conjunto completo).
// ============================================================
{
  const r = interpretarRespuestaSupabase({ data: [{}, {}, {}, {}], error: null, count: 5 }, 500)
  verificar(r.ok === false, 'C. count=5 con 4 filas recibidas → ok=false')
  verificar(!r.ok && r.error.tipo === 'RESPUESTA_INCONSISTENTE' && r.error.count === 5 && r.error.recibidas === 4, 'Cb. El error reporta count(5) y recibidas(4) para diagnóstico')
}

// ============================================================
// D. count === límite, data.length === límite → éxito (el caso límite
//    exacto NO es truncamiento: el rango sí trajo todas las filas).
// ============================================================
{
  const limite = 3
  const r = interpretarRespuestaSupabase({ data: [{}, {}, {}], error: null, count: 3 }, limite)
  verificar(r.ok === true, 'D. count===límite y data.length===límite → ok=true (no es truncamiento)')
}

// ============================================================
// E. OTRO_CICLO con 2 inscripciones en ciclos DISTINTOS entre sí (y
//    distintos al destino) → nunca se elige ninguna arbitrariamente:
//    inscripcionId/grupoId deben quedar ausentes.
// ============================================================
const PROPIO_OTRO_CICLO_AMBIGUO: AlumnoPropioConCurp[] = [{ id: 'otro-ciclo-ambiguo', curp: CURP_A4 }]
const DOS_OTROS_CICLOS: InscripcionPropia[] = [
  { id: 'i-oc1', alumnoId: 'otro-ciclo-ambiguo', grupoId: 'g-x1', cicloEscolarId: 'ciclo-2024', estatus: 'activo' },
  { id: 'i-oc2', alumnoId: 'otro-ciclo-ambiguo', grupoId: 'g-x2', cicloEscolarId: 'ciclo-2025', estatus: 'baja' },
]
{
  const r = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A4, true, 'alta')], PROPIO_OTRO_CICLO_AMBIGUO, DOS_OTROS_CICLOS, DESTINO)
  const candidato = r[0]?.candidatos[0]
  verificar(candidato?.estado === 'OTRO_CICLO', 'E. 2 inscripciones en ciclos distintos al destino → sigue siendo OTRO_CICLO')
  verificar(candidato?.inscripcionId === undefined, 'Eb. inscripcionId ausente — nunca se elige una fila arbitrariamente')
  verificar(candidato?.grupoId === undefined, 'Ec. grupoId ausente — mismo criterio')
  verificar(candidato?.bloqueadoPorRestriccionCiclo === false, 'Ed. No bloqueado por restricción de ciclo (ninguna fila ocupa el par alumno+ciclo-destino)')
}

// ============================================================
// F. Las MISMAS 2 inscripciones de otro ciclo, en orden INVERSO →
//    resultado idéntico (antes de la corrección, esto dependía del
//    orden recibido).
// ============================================================
{
  const rOrdenOriginal = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A4, true, 'alta')], PROPIO_OTRO_CICLO_AMBIGUO, DOS_OTROS_CICLOS, DESTINO)
  const rOrdenInverso = clasificarCandidatosIdentidad(
    [evidencia('Alguien', CURP_A4, true, 'alta')],
    PROPIO_OTRO_CICLO_AMBIGUO,
    [...DOS_OTROS_CICLOS].reverse(),
    DESTINO
  )
  verificar(JSON.stringify(rOrdenOriginal) === JSON.stringify(rOrdenInverso), 'F. Invertir el orden de las 2 inscripciones de otro ciclo produce el MISMO resultado exacto')
}

// ============================================================
// G. Exactamente 1 inscripción de otro ciclo → se conserva la
//    referencia (comportamiento ya existente, sin cambios).
// ============================================================
{
  const propio: AlumnoPropioConCurp[] = [{ id: 'solo-otro-ciclo', curp: CURP_A5 }]
  const unaFila: InscripcionPropia[] = [{ id: 'i-solo', alumnoId: 'solo-otro-ciclo', grupoId: 'g-x', cicloEscolarId: 'ciclo-2024', estatus: 'activo' }]
  const r = clasificarCandidatosIdentidad([evidencia('Alguien', CURP_A5, true, 'alta')], propio, unaFila, DESTINO)
  const candidato = r[0]?.candidatos[0]
  verificar(candidato?.estado === 'OTRO_CICLO' && candidato?.inscripcionId === 'i-solo' && candidato?.grupoId === 'g-x', 'G. Exactamente 1 fila de otro ciclo → se conserva inscripcionId/grupoId (caso inequívoco)')
}

// ============================================================
// H. 2 alumnos propios con la misma CURP, devueltos por Supabase en
//    DISTINTO orden entre 2 llamadas → el orden de candidatos[] es el
//    MISMO (determinista por alumnoId, nunca por el orden de llegada).
// ============================================================
{
  const curpCompartida = CURP_A6
  const ordenA: AlumnoPropioConCurp[] = [
    { id: 'z-segundo', curp: curpCompartida },
    { id: 'a-primero', curp: curpCompartida },
  ]
  const ordenB: AlumnoPropioConCurp[] = [
    { id: 'a-primero', curp: curpCompartida },
    { id: 'z-segundo', curp: curpCompartida },
  ]
  const rA = clasificarCandidatosIdentidad([evidencia('Alguien', curpCompartida, true, 'alta')], ordenA, [], DESTINO)
  const rB = clasificarCandidatosIdentidad([evidencia('Alguien', curpCompartida, true, 'alta')], ordenB, [], DESTINO)
  verificar(JSON.stringify(rA) === JSON.stringify(rB), 'H. El mismo par de alumnos, recibido en distinto orden, produce candidatos[] en el MISMO orden (ordenado por alumnoId)')
  verificar(rA[0]?.candidatos.map((c) => c.alumnoId).join(',') === 'a-primero,z-segundo', 'Hb. El orden resultante es por alumnoId (a-primero antes de z-segundo), nunca por orden de llegada')
  verificar(rA[0]?.multiplesCoincidencias === true, 'Hc. multiplesCoincidencias se preserva correctamente tras el reordenamiento')
}

// ============================================================
// I. Dos evidencias documentales idénticas siguen produciendo 2
//    resultados independientes, conservando su posición original —
//    reconfirmado tras las correcciones (ver también prueba 18).
// ============================================================
{
  const propio: AlumnoPropioConCurp[] = [{ id: 'solo-identico', curp: CURP_A7 }]
  const evIdenticas: EvidenciaDocumentoAlumnoNuevo[] = [
    evidencia('Mismo Nombre', CURP_A7, true, 'alta'),
    evidencia('Mismo Nombre', CURP_A7, true, 'alta'),
  ]
  const r = clasificarCandidatosIdentidad(evIdenticas, propio, [], DESTINO)
  verificar(r.length === 2 && JSON.stringify(r[0]) === JSON.stringify(r[1]), 'I. 2 evidencias documentales idénticas producen 2 resultados independientes e idénticos entre sí, cada uno en su posición original')
}

console.log('')
if (fallos > 0) {
  console.error(`${fallos} prueba(s) fallaron.`)
  process.exit(1)
}
console.log('Todas las pruebas pasaron.')
