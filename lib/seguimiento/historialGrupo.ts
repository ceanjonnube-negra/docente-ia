// lib/seguimiento/historialGrupo.ts
//
// EVAL-1K — read-model acumulativo del historial grupal, construido
// EXCLUSIVAMENTE a partir de lo que resultadosProyectoGrupo()
// (lib/motorContexto.ts) ya devuelve en 1 sola query. Pura,
// determinista, 0 IA, 0 I/O, 0 conocimiento de autenticación/React/
// APIs — mismo criterio de capas que
// lib/seguimiento/resultadosConfirmados.ts (EVAL-1J) y
// construirMatrizRevision() (confirmarResultadosHoja.ts): nunca se
// mezcla la responsabilidad de LEER (motorContexto.ts) con la de
// REORGANIZAR en memoria (este archivo).
//
// Deliberadamente NO calcula: promedio, porcentaje convertido a
// calificación, nivel final, nivel predominante, semáforo,
// recomendación, progreso o tendencia inferida — ninguna conclusión
// pedagógica automática. Solo reestructura y cuenta datos ya
// existentes (ver RESUMEN más abajo).
//
// nivel/aspecto_general LLEGAN a resultadosProyectoGrupo() mediante
// `(data || []) as unknown as ResultadoProyectoGrupo[]`
// (lib/motorContexto.ts) — un doble cast de TypeScript, nunca una
// validación en runtime: el cliente de Supabase no verifica contra
// ningún CHECK, solo entrega el JSON crudo de la fila. Esta capa es
// la PRIMERA frontera real donde el dato externo se valida de verdad
// antes de usarse — mismo principio fail-closed ya aplicado en EVAL-1J
// (lib/seguimiento/resultadosConfirmados.ts): un valor fuera del
// dominio canónico real nunca se convierte, aproxima, ni deja crear
// una categoría dinámica nueva — la fila completa se excluye de forma
// explícita y visible (ver entradasInvalidasExcluidas), nunca de
// "primero/último gana" ni en silencio.

import type { ResultadoProyectoGrupo } from '../motorContexto'
import type { AspectoGeneral } from './tipos'
import { ASPECTOS_GENERALES } from './tipos'
import type { NivelTextoCanonico } from './conversionCalificacion'

// Único lugar de este archivo donde se escriben los 5 valores
// literales — tanto la plantilla de conteo (distribucionNivelesVacia)
// como el validador de dominio (esNivelValido) se derivan de aquí,
// nunca se repiten sueltos. Mismo dominio canónico documentado en
// conversionCalificacion.ts (NivelTextoCanonico, CHECK real de
// seguimiento_resultados.nivel) — no existe hoy un array exportado
// equivalente en ese archivo (solo el tipo TypeScript, que un cast no
// garantiza en runtime), así que se declara aquí explícitamente en
// vez de reimportar el Set privado y no exportado de
// resultadosConfirmados.ts (eso habría exigido tocar un archivo de
// EVAL-1J, fuera del alcance de esta fase).
const NIVELES_TEXTO_CANONICO: NivelTextoCanonico[] = ['destacado', 'logrado', 'en_proceso', 'requiere_apoyo', 'no_evaluado']
const NIVELES_TEXTO_CANONICO_VALIDOS = new Set<string>(NIVELES_TEXTO_CANONICO)

// Reutiliza el array YA EXPORTADO de lib/seguimiento/tipos.ts — nunca
// se duplica la lista de valores de AspectoGeneral, solo se deriva un
// Set de búsqueda O(1) a partir de la fuente real ya existente.
const ASPECTOS_GENERALES_VALIDOS = new Set<string>(ASPECTOS_GENERALES.map((a) => a.valor))

function esNivelValido(valor: unknown): valor is NivelTextoCanonico {
  return typeof valor === 'string' && NIVELES_TEXTO_CANONICO_VALIDOS.has(valor)
}

function esAspectoGeneralValido(valor: unknown): valor is AspectoGeneral {
  return typeof valor === 'string' && ASPECTOS_GENERALES_VALIDOS.has(valor)
}

// Las 5 claves se inicializan en 0 explícitamente (nunca solo las que
// aparecieron en los datos) — un nivel con 0 ocurrencias reales debe
// verse como 0, nunca estar ausente del resumen.
function distribucionNivelesVacia(): Record<NivelTextoCanonico, number> {
  return Object.fromEntries(NIVELES_TEXTO_CANONICO.map((n) => [n, 0])) as Record<NivelTextoCanonico, number>
}

export type IndicadorConfirmadoGrupo = {
  indicadorNumero: number
  indicadorEspecifico: string
  aspectoGeneral: AspectoGeneral
  nivel: NivelTextoCanonico
}

// Metadata de un proyecto — deliberadamente SOLO estos 3 campos (los
// únicos que resultadosProyectoGrupo() ya conoce por proyecto): nunca
// se inventa un nombre/fecha que esa función no devuelve.
export type ProyectoHistorialGrupo = {
  proyectoId: string
  confirmadoEn: string | null
  periodoEvaluacionId: string | null
}

export type ProyectoDeAlumno = ProyectoHistorialGrupo & {
  // Ordenados por indicadorNumero ascendente (sección 8) — nunca se
  // repite proyectoId/alumnoId/inscripcionId aquí dentro: ya los fija
  // el nodo padre (alumno) y el nodo abuelo (este mismo proyecto), ver
  // "no duplicar innecesariamente todas las filas en varias
  // representaciones".
  indicadores: IndicadorConfirmadoGrupo[]
}

export type AlumnoHistorialGrupo = {
  alumnoId: string
  inscripcionId: string
  // Ordenados por confirmadoEn desc, proyectoId asc como desempate
  // (sección 8) — mismo criterio que la lista de proyectos del nivel
  // superior.
  proyectos: ProyectoDeAlumno[]
}

// Agregados DETERMINISTAS permitidos (sección 7) — exclusivamente
// conteo directo de datos existentes, nunca promedio/porcentaje/nivel
// final/semáforo/recomendación.
export type ResumenHistorialGrupo = {
  proyectosConfirmados: number
  alumnosConResultados: number
  totalIndicadoresConfirmados: number
  distribucionNiveles: Record<NivelTextoCanonico, number>
  distribucionNivelesPorAspecto: Record<AspectoGeneral, Record<NivelTextoCanonico, number>>
}

export type HistorialGrupo = {
  proyectos: ProyectoHistorialGrupo[]
  alumnos: AlumnoHistorialGrupo[]
  resumen: ResumenHistorialGrupo
  // Nunca "primero gana" ni "último gana" (sección 9): cuenta cuántas
  // FILAS se excluyeron de la reconstrucción/resumen por compartir una
  // identidad lógica (proyecto_id + inscripcion_id + indicador_numero)
  // con otra fila — el UNIQUE real de la tabla debería impedirlo, pero
  // esta función nunca asume esa garantía sin verificarla. 0 en el
  // caso normal; cualquier valor > 0 es una señal visible de
  // inconsistencia real en los datos, nunca oculta en silencio.
  entradasAmbiguasExcluidas: number
  // Cuenta cuántas FILAS se excluyeron porque `nivel` y/o
  // `aspecto_general` no pertenecen al dominio canónico real (ver
  // esNivelValido/esAspectoGeneralValido) — nunca por duplicado de
  // identidad (eso es entradasAmbiguasExcluidas, campo separado a
  // propósito: son dos motivos de exclusión distintos, cada contador
  // debe reflejar exactamente lo que cuenta). 0 en el caso normal.
  entradasInvalidasExcluidas: number
}

function claveIdentidad(fila: ResultadoProyectoGrupo): string {
  return `${fila.proyecto_id}:${fila.inscripcion_id}:${fila.indicador_numero}`
}

// Pura, determinista, 0 IA, 0 I/O. Recibe exactamente lo que
// resultadosProyectoGrupo() ya devuelve — nunca consulta Supabase ni
// conoce cómo se obtuvieron esas filas.
export function construirHistorialGrupo(filas: ResultadoProyectoGrupo[]): HistorialGrupo {
  // Paso 1a — detectar duplicados de identidad ANTES de construir
  // nada: una clave vista más de una vez se marca ambigua (las N
  // filas que la comparten, no solo la 2ª en adelante) — nunca
  // "primero gana"/"último gana".
  const vistas = new Set<string>()
  const ambiguas = new Set<string>()
  for (const fila of filas) {
    const clave = claveIdentidad(fila)
    if (vistas.has(clave)) ambiguas.add(clave)
    vistas.add(clave)
  }

  // Paso 1b — un solo recorrido que excluye, de forma EXPLÍCITA y
  // contada (nunca en silencio), dos motivos distintos de exclusión:
  // identidad ambigua (arriba) y dominio inválido de nivel/aspecto_general
  // (la frontera runtime real frente a lo que Supabase devuelve — ver
  // comentario superior del archivo). Una fila con cualquiera de los
  // dos problemas queda fuera de TODA la reconstrucción (estructura Y
  // resumen) — nunca se convierte, aproxima, ni crea una categoría
  // dinámica nueva.
  let entradasAmbiguasExcluidas = 0
  let entradasInvalidasExcluidas = 0
  const filasValidas: ResultadoProyectoGrupo[] = []
  for (const fila of filas) {
    if (ambiguas.has(claveIdentidad(fila))) {
      entradasAmbiguasExcluidas++
      continue
    }
    if (!esNivelValido(fila.nivel) || !esAspectoGeneralValido(fila.aspecto_general)) {
      entradasInvalidasExcluidas++
      continue
    }
    filasValidas.push(fila)
  }

  // Paso 2 — proyectos presentes (deduplicados por proyecto_id;
  // confirmadoEn/periodoEvaluacionId vienen del embed ya incluido en
  // cada fila, nunca de una consulta adicional).
  const proyectosPorId = new Map<string, ProyectoHistorialGrupo>()
  for (const fila of filasValidas) {
    if (!proyectosPorId.has(fila.proyecto_id)) {
      proyectosPorId.set(fila.proyecto_id, {
        proyectoId: fila.proyecto_id,
        confirmadoEn: fila.proyectos_seguimiento?.confirmado_en ?? null,
        periodoEvaluacionId: fila.proyectos_seguimiento?.periodo_evaluacion_id ?? null,
      })
    }
  }
  const compararProyectos = (a: ProyectoHistorialGrupo, b: ProyectoHistorialGrupo): number => {
    const confirmadoA = a.confirmadoEn ?? ''
    const confirmadoB = b.confirmadoEn ?? ''
    if (confirmadoA !== confirmadoB) return confirmadoB.localeCompare(confirmadoA)
    return a.proyectoId.localeCompare(b.proyectoId)
  }
  const proyectos = Array.from(proyectosPorId.values()).sort(compararProyectos)

  // Paso 3 — alumnos presentes, cada uno con sus proyectos anidados e
  // indicadores dentro de cada proyecto. inscripcion_id es la clave de
  // agrupación (identidad canónica real de un resultado, ver UNIQUE de
  // seguimiento_resultados) — alumno_id se conserva como dato, nunca
  // como clave, porque un alumno puede tener más de una inscripción.
  type ProyectoDeAlumnoMutable = ProyectoHistorialGrupo & { indicadores: IndicadorConfirmadoGrupo[] }
  const alumnosPorInscripcion = new Map<string, { alumnoId: string; inscripcionId: string; proyectos: Map<string, ProyectoDeAlumnoMutable> }>()

  for (const fila of filasValidas) {
    let alumno = alumnosPorInscripcion.get(fila.inscripcion_id)
    if (!alumno) {
      alumno = { alumnoId: fila.alumno_id, inscripcionId: fila.inscripcion_id, proyectos: new Map() }
      alumnosPorInscripcion.set(fila.inscripcion_id, alumno)
    }
    let proyectoDeAlumno = alumno.proyectos.get(fila.proyecto_id)
    if (!proyectoDeAlumno) {
      proyectoDeAlumno = {
        proyectoId: fila.proyecto_id,
        confirmadoEn: fila.proyectos_seguimiento?.confirmado_en ?? null,
        periodoEvaluacionId: fila.proyectos_seguimiento?.periodo_evaluacion_id ?? null,
        indicadores: [],
      }
      alumno.proyectos.set(fila.proyecto_id, proyectoDeAlumno)
    }
    proyectoDeAlumno.indicadores.push({
      indicadorNumero: fila.indicador_numero,
      indicadorEspecifico: fila.indicador_especifico,
      aspectoGeneral: fila.aspecto_general,
      nivel: fila.nivel,
    })
  }

  const alumnos: AlumnoHistorialGrupo[] = Array.from(alumnosPorInscripcion.values())
    .map((alumno) => ({
      alumnoId: alumno.alumnoId,
      inscripcionId: alumno.inscripcionId,
      proyectos: Array.from(alumno.proyectos.values())
        .map((p) => ({ ...p, indicadores: p.indicadores.slice().sort((a, b) => a.indicadorNumero - b.indicadorNumero) }))
        .sort(compararProyectos),
    }))
    .sort((a, b) => a.inscripcionId.localeCompare(b.inscripcionId))

  // Paso 4 — resumen agregado: solo conteo directo, inicializando las
  // 5 claves de nivel/aspecto en 0 para que una categoría sin
  // ocurrencias se vea como 0, nunca como ausente.
  const distribucionNiveles = distribucionNivelesVacia()
  const distribucionNivelesPorAspecto = Object.fromEntries(
    ASPECTOS_GENERALES.map((a) => [a.valor, distribucionNivelesVacia()])
  ) as Record<AspectoGeneral, Record<NivelTextoCanonico, number>>

  for (const fila of filasValidas) {
    distribucionNiveles[fila.nivel]++
    distribucionNivelesPorAspecto[fila.aspecto_general][fila.nivel]++
  }

  const resumen: ResumenHistorialGrupo = {
    proyectosConfirmados: proyectos.length,
    alumnosConResultados: alumnos.length,
    totalIndicadoresConfirmados: filasValidas.length,
    distribucionNiveles,
    distribucionNivelesPorAspecto,
  }

  return { proyectos, alumnos, resumen, entradasAmbiguasExcluidas, entradasInvalidasExcluidas }
}
