// lib/seguimiento/resultadosConfirmados.ts
//
// Lectura pura de resultados YA CONFIRMADOS de una hoja de evaluación
// — deliberadamente en un archivo separado de
// lib/seguimiento/confirmarResultadosHoja.ts: esa función es la ÚNICA
// que escribe/confirma (captura, matching, upsert real); esta es
// exclusivamente de consulta posterior, sobre la tabla canónica
// seguimiento_resultados, NUNCA sobre captura_pendiente (el staging
// de la fotografía/OCR) — nunca la misma fuente, nunca el mismo
// archivo, para no mezclar responsabilidades de confirmación con
// responsabilidades de consulta.
//
// Mismo patrón de identidad que construirMatrizRevision() (roster
// congelado por posición, indicadores congelados por número) — pero
// la celda aquí es el nivel textual REAL ya persistido, nunca una
// lectura de IA ni una celda bloqueante/corregible.

import type { AlumnoRosterCongelado, IndicadorCongelado, AspectoGeneral } from './tipos'
import type { NivelTextoCanonico } from './conversionCalificacion'

// Forma mínima de una fila real de seguimiento_resultados que esta
// función necesita — no el tipo completo de la tabla, para no atar
// este archivo de lectura a cada columna que confirmarResultadosHoja.ts
// decida escribir. `nivel` llega como `string` (NUNCA ya tipado como
// NivelTextoCanonico) a propósito: el cast en el route handler no es
// una validación real — el dato viene de la base de datos, no de
// TypeScript, y debe validarse en runtime contra el dominio canónico
// real antes de confiar en él (ver NIVELES_TEXTO_CANONICO_VALIDOS).
export type FilaResultadoConfirmadoLectura = {
  inscripcion_id: string
  indicador_numero: number
  nivel: string
}

// Dominio canónico REAL de seguimiento_resultados.nivel — el mismo
// CHECK documentado en lib/seguimiento/conversionCalificacion.ts
// (comentario de NivelTextoCanonico, línea 22-23: "CHECK real:
// 'destacado'|'logrado'|'en_proceso'|'requiere_apoyo'|'no_evaluado'").
// Nunca se deduce de memoria aquí ni se reinventa: es la misma fuente
// ya documentada en el código. Cualquier valor fuera de este set —
// null, undefined, cadena vacía, o cualquier string desconocido — se
// trata como dato no disponible, nunca como un nivel aproximado.
const NIVELES_TEXTO_CANONICO_VALIDOS = new Set<string>([
  'destacado',
  'logrado',
  'en_proceso',
  'requiere_apoyo',
  'no_evaluado',
])

function nivelCanonicoValidado(valor: unknown): NivelTextoCanonico | null {
  return typeof valor === 'string' && NIVELES_TEXTO_CANONICO_VALIDOS.has(valor) ? (valor as NivelTextoCanonico) : null
}

// Sentinela interno — nunca se expone fuera de esta función. Marca
// una combinación inscripcion_id+indicador_numero que apareció MÁS DE
// UNA VEZ en filasConfirmadas (debería ser imposible por el UNIQUE
// real de la tabla — proyecto_id+inscripcion_id+indicador_numero,
// mismo onConflict que usa confirmar-hoja/route.ts — pero esta función
// nunca asume una garantía de base de datos sin verificarla: ante una
// inconsistencia histórica real, "último gana" u "primero gana"
// ocultaría silenciosamente el problema). Se resuelve siempre a null
// (celda no disponible), nunca a uno de los dos valores en conflicto.
const AMBIGUO = Symbol('nivel_ambiguo_duplicado')

export type CeldaResultadoConfirmado = {
  numeroIndicador: number
  indicadorEspecifico: string
  aspectoGeneral: AspectoGeneral
  // null ÚNICAMENTE cuando no existe fila real para esa combinación
  // alumno×indicador (no debería ocurrir una vez confirmado, pero la
  // UI debe poder mostrar "—" en vez de inventar un nivel si pasara) —
  // nunca un valor por defecto.
  nivel: NivelTextoCanonico | null
}

export type AlumnoResultadoConfirmado = {
  alumnoId: string
  inscripcionId: string
  nombre: string
  posicion: number
  celdas: CeldaResultadoConfirmado[]
}

export type MatrizResultadosConfirmados = {
  alumnos: AlumnoResultadoConfirmado[]
}

// Pura, determinista, 0 IA, 0 I/O — igual que construirMatrizRevision().
// Nunca lanza: si falta una fila, si el nivel no es uno de los 5
// valores canónicos reales, o si hay una fila duplicada para la misma
// celda, esa celda específica queda en null — nunca rompe el resto de
// la matriz, nunca aproxima, nunca adivina.
export function construirMatrizResultadosConfirmados(
  filasConfirmadas: FilaResultadoConfirmadoLectura[],
  rosterCongelado: AlumnoRosterCongelado[],
  indicadoresCongelados: IndicadorCongelado[]
): MatrizResultadosConfirmados {
  const nivelesPorInscripcionEIndicador = new Map<string, NivelTextoCanonico | null | typeof AMBIGUO>()
  for (const fila of filasConfirmadas) {
    const clave = `${fila.inscripcion_id}:${fila.indicador_numero}`
    // Clave ya vista antes en este mismo resultado → duplicado real
    // para la misma inscripcion_id+indicador_numero (el UNIQUE de la
    // tabla debería impedirlo; si de todos modos ocurre, se marca
    // como ambiguo y JAMÁS se decide cuál de los dos es el correcto,
    // sin importar si alguno de los dos valores era válido).
    if (nivelesPorInscripcionEIndicador.has(clave)) {
      nivelesPorInscripcionEIndicador.set(clave, AMBIGUO)
      continue
    }
    // Primera vez que se ve esta celda: el valor queda validado contra
    // el dominio canónico real — si no pertenece a él (null/undefined/
    // vacío/desconocido), se guarda null (dato no disponible), nunca
    // un valor aproximado.
    nivelesPorInscripcionEIndicador.set(clave, nivelCanonicoValidado(fila.nivel))
  }
  const indicadoresOrdenados = indicadoresCongelados.slice().sort((a, b) => a.numero_indicador - b.numero_indicador)

  const alumnos: AlumnoResultadoConfirmado[] = rosterCongelado
    .slice()
    .sort((a, b) => a.posicion - b.posicion)
    .map((alumno) => ({
      alumnoId: alumno.alumno_id,
      inscripcionId: alumno.inscripcion_id,
      nombre: alumno.nombre,
      posicion: alumno.posicion,
      celdas: indicadoresOrdenados.map((indicador) => {
        const valor = nivelesPorInscripcionEIndicador.get(`${alumno.inscripcion_id}:${indicador.numero_indicador}`)
        return {
          numeroIndicador: indicador.numero_indicador,
          indicadorEspecifico: indicador.indicador_especifico,
          aspectoGeneral: indicador.aspecto_general,
          nivel: valor === undefined || valor === AMBIGUO ? null : valor,
        }
      }),
    }))

  return { alumnos }
}
