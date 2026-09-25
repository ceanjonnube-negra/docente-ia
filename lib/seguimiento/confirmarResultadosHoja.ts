// lib/seguimiento/confirmarResultadosHoja.ts
//
// EVAL-1E — lógica pura (sin Supabase, sin IA, 0 red) que convierte la
// transcripción YA VALIDADA en EVAL-1D (captura_pendiente.extraidoBruto)
// en las filas reales que se escribirán en seguimiento_resultados.
// Mismo criterio que generarYGuardarHoja.ts: la lógica de negocio vive
// aparte, probable sin credenciales — el route handler
// (confirmar-hoja/route.ts) solo hace auth/fetch/persistencia.
//
// Decisiones cerradas (ver conversación EVAL-1E):
// 1. Si extraidoBruto no cubrió TODAS las posiciones del roster
//    congelado (menos filas que alumnos), se rechaza la confirmación
//    COMPLETA — fail-closed, nunca se confirma una hoja incompleta.
// 2. Una celda BLOQUEA la confirmación completa únicamente si:
//      - su lectura es 'lectura_dudosa' (varios dígitos/ruido), o
//      - su lectura es 'nivel' pero la confianza reportada no es 'alta'.
//    Una celda 'no_evaluado' NUNCA bloquea, sin importar su confianza
//    — "no evaluado" es un valor real del sistema (ver tipos.ts), no
//    una lectura fallida. Se persiste como nivel='no_evaluado'.
// 3. Alcance de EVAL-1E: solo esta preparación + el endpoint de
//    confirmación. Ninguna UI de corrección — una hoja con al menos
//    una celda bloqueante simplemente no podía confirmarse.
//
// EVAL-1F — agrega la corrección manual de celdas (corregir-celda/route.ts)
// y la vista de revisión (revisar-hoja/route.ts + pantalla). Una celda
// con corregidoManualmente=true (el docente la escribió a mano,
// sobrescribiendo lo que la IA transcribió) NUNCA bloquea, sin
// importar su lectura/confianza — es la señal de más alta prioridad,
// evaluada ANTES que las reglas de la IA. Al persistir, esa celda
// ahora escribe corregido_manualmente=true y fuente_correccion='docente'
// en seguimiento_resultados (columnas ya preparadas en EVAL-1B, nunca
// escritas hasta ahora) — antes de EVAL-1F, toda fila persistida tenía
// necesariamente corregido_manualmente=false (ninguna celda bloqueante
// podía llegar a confirmarse).

import type { ResultadoExtraccionHojaEvaluacion, CeldaHojaEvaluacion, ConfianzaLecturaHoja } from './analisisHojaEvaluacion'
import { nivelATextoCanonico } from './conversionCalificacion'
import { CANTIDAD_INDICADORES_HOJA, type AlumnoRosterCongelado, type IndicadorCongelado, type AspectoGeneral } from './tipos'
import type { NivelTextoCanonico } from './conversionCalificacion'

// Fila lista para insertar/upsertar en seguimiento_resultados — mismas
// columnas reales de la tabla (ver migración EVAL-1B), sin ningún
// campo que la tabla no tenga.
export type FilaResultadoConfirmado = {
  proyecto_id: string
  alumno_id: string
  inscripcion_id: string
  indicador_especifico: string
  aspecto_general: AspectoGeneral
  nivel: NivelTextoCanonico
  confianza: number
  corregido_manualmente: boolean
  fuente_correccion: 'docente' | null
  observacion: null
  indicador_numero: number
}

// nivel='nivel' con confianza no-alta, o lectura_dudosa: requieren ojos
// humanos antes de tratarse como dato confiable. 'no_evaluado' NUNCA
// bloquea (decisión #2 de EVAL-1E): una celda en blanco con cualquier
// confianza es un resultado real, no una lectura fallida. EVAL-1F —
// corregidoManualmente=true se evalúa PRIMERO y siempre gana: una
// celda que el docente ya escribió a mano nunca vuelve a bloquear, sin
// importar qué lectura/confianza traía de la IA antes de corregirla.
// Exportada (antes privada) — la usa también construirMatrizRevision
// para marcar qué celdas necesitan la atención del docente.
export function esCeldaBloqueante(celda: CeldaHojaEvaluacion): boolean {
  if (celda.corregidoManualmente === true) return false
  if (celda.lectura.estado === 'lectura_dudosa') return true
  if (celda.lectura.estado === 'nivel' && celda.confianza !== 'alta') return true
  return false
}

// La columna seguimiento_resultados.confianza es numeric — la IA
// reporta un enum categórico. Mapeo determinista y documentado, nunca
// un valor adivinado: alta=1, media=0.5, baja=0. Se aplica igual a
// celdas 'nivel' (siempre 'alta' por construcción, ya que cualquier
// 'nivel' con confianza distinta es bloqueante y nunca llega aquí) y a
// celdas 'no_evaluado' (conserva qué tan segura estuvo la IA de que en
// verdad estaba vacía, información real que no hay razón para descartar).
const MAPA_CONFIANZA_NUMERICA: Record<ConfianzaLecturaHoja, number> = { alta: 1, media: 0.5, baja: 0 }

// Cuenta cuántas celdas bloquean la confirmación en todo el resultado
// — usado tanto para decidir si se rechaza como para dar al docente un
// número real en el mensaje de error (nunca un genérico "hay errores").
export function contarCeldasBloqueantes(extraidoBruto: ResultadoExtraccionHojaEvaluacion): number {
  let total = 0
  for (const fila of extraidoBruto.filas) {
    for (const celda of fila.celdas) {
      if (esCeldaBloqueante(celda)) total++
    }
  }
  return total
}

// Punto de entrada puro: aplica las 2 reglas fail-closed (decisiones
// #1 y #2) y, solo si ambas pasan, construye TODAS las filas a
// insertar (roster.length * CANTIDAD_INDICADORES_HOJA filas exactas,
// nunca de más ni de menos). Lanza Error con un mensaje honesto ante
// cualquier violación — el route handler lo traduce a 409, nunca
// aproxima ni confirma una hoja parcial.
export function prepararResultadosConfirmacion(
  proyectoId: string,
  extraidoBruto: ResultadoExtraccionHojaEvaluacion,
  rosterCongelado: AlumnoRosterCongelado[],
  indicadoresCongelados: IndicadorCongelado[]
): FilaResultadoConfirmado[] {
  // Decisión #1 — cobertura completa del roster. Combinado con que
  // validarResultadoExtraccionHoja (EVAL-1D) ya garantizó, al momento
  // de escribir extraidoBruto, que cada fila.posicion es única y está
  // dentro de 1..rosterCongelado.length, esta sola igualdad basta para
  // asegurar que las N posiciones cubren EXACTAMENTE el roster
  // completo (nunca hace falta un segundo barrido "¿falta alguien?").
  if (extraidoBruto.filas.length !== rosterCongelado.length) {
    throw new Error(
      `Esta hoja tiene ${rosterCongelado.length} alumno(s) pero la transcripción solo cubrió ${extraidoBruto.filas.length}. Vuelve a fotografiar/analizar la hoja completa antes de confirmar.`
    )
  }

  // Decisión #2 — ninguna celda bloqueante sin resolver.
  const bloqueantes = contarCeldasBloqueantes(extraidoBruto)
  if (bloqueantes > 0) {
    throw new Error(
      `Esta hoja tiene ${bloqueantes} celda(s) que requieren revisión manual (lectura ambigua o poco confiable) antes de poder confirmarse.`
    )
  }

  const rosterPorPosicion = new Map(rosterCongelado.map((a) => [a.posicion, a]))
  const indicadorPorNumero = new Map(indicadoresCongelados.map((i) => [i.numero_indicador, i]))
  // Defensivo: por construcción (ver generarYGuardarHoja.ts) siempre
  // existen exactamente CANTIDAD_INDICADORES_HOJA indicadores
  // congelados numerados 1..N — pero nunca se asume en silencio.
  for (let n = 1; n <= CANTIDAD_INDICADORES_HOJA; n++) {
    if (!indicadorPorNumero.has(n)) {
      throw new Error('Los indicadores congelados de esta hoja están incompletos — no se puede confirmar.')
    }
  }

  const filas: FilaResultadoConfirmado[] = []
  for (const fila of extraidoBruto.filas) {
    const alumno = rosterPorPosicion.get(fila.posicion)
    // Defensivo (ver comentario de la decisión #1): no debería poder
    // faltar, pero nunca se asume en silencio ante datos que vienen de
    // una columna jsonb.
    if (!alumno) {
      throw new Error(`La posición ${fila.posicion} de la transcripción no corresponde a ningún alumno del roster congelado.`)
    }
    for (const celda of fila.celdas) {
      const indicador = indicadorPorNumero.get(celda.numeroIndicador)
      if (!indicador) {
        throw new Error(`El indicador ${celda.numeroIndicador} de la transcripción no corresponde a ningún indicador congelado de esta hoja.`)
      }
      const corregido = celda.corregidoManualmente === true
      filas.push({
        proyecto_id: proyectoId,
        alumno_id: alumno.alumno_id,
        inscripcion_id: alumno.inscripcion_id,
        indicador_especifico: indicador.indicador_especifico,
        aspecto_general: indicador.aspecto_general,
        nivel: nivelATextoCanonico(celda.lectura.estado === 'nivel' ? celda.lectura.nivel : null),
        confianza: MAPA_CONFIANZA_NUMERICA[celda.confianza],
        corregido_manualmente: corregido,
        fuente_correccion: corregido ? 'docente' : null,
        observacion: null,
        indicador_numero: celda.numeroIndicador,
      })
    }
  }
  return filas
}

// EVAL-1F — matriz lista para que la pantalla de revisión la renderice
// directamente, sin que el frontend tenga que repetir el matching
// posición<->alumno / numeroIndicador<->indicador (esa lógica vive
// aquí una sola vez, la misma que usa prepararResultadosConfirmacion).
// A diferencia de prepararResultadosConfirmacion, esta función NUNCA
// lanza — está pensada para mostrarle al docente el estado real de la
// hoja incluso cuando todavía no se puede confirmar (cobertura
// incompleta, celdas bloqueantes), nunca para persistir nada.
export type CeldaRevision = {
  numeroIndicador: number
  indicadorEspecifico: string
  aspectoGeneral: AspectoGeneral
  lectura: CeldaHojaEvaluacion['lectura']
  confianza: ConfianzaLecturaHoja
  bloqueante: boolean
  corregidoManualmente: boolean
}

export type AlumnoRevision = {
  alumnoId: string
  inscripcionId: string
  nombre: string
  posicion: number
  // false si esta posición no tiene ninguna fila en extraidoBruto
  // (cobertura incompleta) — la pantalla debe mostrar esto como "sin
  // leer todavía", nunca como si el alumno tuviera 0 en todo.
  cubierto: boolean
  celdas: CeldaRevision[]
}

export type MatrizRevision = {
  alumnos: AlumnoRevision[]
  coberturaCompleta: boolean
  totalBloqueantes: number
  // true únicamente cuando confirmar-hoja SÍ aceptaría esta hoja tal
  // como está ahora mismo — la pantalla usa esto, y solo esto, para
  // habilitar el botón "Confirmar".
  listaParaConfirmar: boolean
}

export function construirMatrizRevision(
  extraidoBruto: ResultadoExtraccionHojaEvaluacion,
  rosterCongelado: AlumnoRosterCongelado[],
  indicadoresCongelados: IndicadorCongelado[]
): MatrizRevision {
  const filaPorPosicion = new Map(extraidoBruto.filas.map((f) => [f.posicion, f]))
  const indicadorPorNumero = new Map(indicadoresCongelados.map((i) => [i.numero_indicador, i]))

  const alumnos: AlumnoRevision[] = rosterCongelado
    .slice()
    .sort((a, b) => a.posicion - b.posicion)
    .map((alumno) => {
      const fila = filaPorPosicion.get(alumno.posicion)
      const celdas: CeldaRevision[] = fila
        ? fila.celdas
            .slice()
            .sort((a, b) => a.numeroIndicador - b.numeroIndicador)
            .map((celda) => {
              const indicador = indicadorPorNumero.get(celda.numeroIndicador)
              return {
                numeroIndicador: celda.numeroIndicador,
                indicadorEspecifico: indicador?.indicador_especifico ?? '',
                aspectoGeneral: indicador?.aspecto_general ?? 'logro_aprendizaje',
                lectura: celda.lectura,
                confianza: celda.confianza,
                bloqueante: esCeldaBloqueante(celda),
                corregidoManualmente: celda.corregidoManualmente === true,
              }
            })
        : []
      return {
        alumnoId: alumno.alumno_id,
        inscripcionId: alumno.inscripcion_id,
        nombre: alumno.nombre,
        posicion: alumno.posicion,
        cubierto: fila !== undefined,
        celdas,
      }
    })

  const coberturaCompleta = extraidoBruto.filas.length === rosterCongelado.length
  const totalBloqueantes = contarCeldasBloqueantes(extraidoBruto)

  return {
    alumnos,
    coberturaCompleta,
    totalBloqueantes,
    listaParaConfirmar: coberturaCompleta && totalBloqueantes === 0,
  }
}
