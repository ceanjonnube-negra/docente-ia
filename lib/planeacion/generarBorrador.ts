// lib/planeacion/generarBorrador.ts
//
// Ensamblado de contexto real para planeacion_generar (C-005, Paso
// 3B) — nunca redacta el borrador (eso lo hace Claude, con este
// contexto ya inyectado, exactamente igual que ficha_descriptiva y el
// resto del bloque Nivel 4 de app/api/chat/route.ts), nunca escribe
// en la base de datos (solo lecturas), nunca crea su propio cliente
// de Supabase ni usa service_role — recibe siempre el cliente ya
// autenticado de la solicitud.
//
// Reutiliza obligatoriamente calcularFechasPlaneacion()
// (lib/planeacion/calculoFechasHabiles.ts) como única autoridad para
// la aritmética real de días — este módulo solo prepara sus
// parámetros a partir de datos reales (calendario, periodos,
// planeaciones previas), nunca reimplementa el cálculo de fechas.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  calendarioCicloCompleto,
  contextoGrupo,
  periodosEvaluacionDelCiclo,
  type EventoCalendarioCompleto,
  type PeriodoEvaluacion,
} from '../motorContexto'
import { listarPlaneaciones } from './persistencia'
import { calcularFechasPlaneacion, type DiaNoLaborable, type ResultadoCalculoFechas } from './calculoFechasHabiles'
import type { SesionContexto } from '../sesionContexto'
import type { ResumenBorrador } from './extraerBorrador'
import type { PlaneacionActivaV3 } from './planeacionActiva'
import { prepararContextoCurricularPlaneacion, type ContextoCurricularParaPrompt } from './resolverCurricularPlaneacion'

export type SolicitudGeneracionPlaneacion = {
  tema: string | null
  fechaInicio: string | null
  fechaFin: string | null
  duracionDias: number | null
  duracionSemanas: number | null
  momentoRelativo: string | null
}

export type ResumenPlaneacionPrevia = { nombre: string; periodo: string | null; fechaInicio: string | null; fechaFin: string | null }

export type ResultadoContextoGeneracion = {
  contextoGrupo: unknown
  fechas: ResultadoCalculoFechas
  explicacionMomentoRelativo: string | null
  periodoEvaluacionActual: PeriodoEvaluacion | null
  planeacionesPrevias: ResumenPlaneacionPrevia[]
  eventosCalendarioDelPeriodo: { fecha: string; titulo: string; motivo: string }[]
  // Fase 3B.3 — presente SOLO cuando el llamador pasó un snapshot V3
  // heredado (turno de 'ajustar' con planeacion_activa válida). Es la
  // fuente canónica real de la planeación vigente — nunca el
  // historial de la conversación ni el marcador "📎 RESUMEN PARA
  // GUARDAR" — para que la generación pueda modificar únicamente lo
  // solicitado y conservar el resto.
  planeacionVigente: { borrador: ResumenBorrador; contenidoCompleto: string } | null
  // PLN-1C — null cuando el grupo todavía no tiene Programa Analítico
  // publicado (comportamiento actual sin cambios: Claude sigue usando
  // MARCO_CURRICULAR_VIGENTE + su criterio). Cuando existe, es la
  // ÚNICA fuente de identidad curricular para este turno — ver
  // lib/asistente/instruccionesPlaneacionGenerar.ts. Nunca incluye el
  // array completo de candidatos con PDA (eso se recarga server-side
  // después de la respuesta, para validar — ver route.ts y
  // lib/planeacion/validarSeleccionCurricularPlaneacion.ts).
  contextoCurricularPlaneacion: ContextoCurricularParaPrompt | null
}

// Solo eventos OFICIALES SEP cancelan clases automáticamente — una
// actividad propia que el docente agregó a su calendario nunca reduce
// por sí sola los días efectivos disponibles (mismo criterio que ya
// usa categoriaEventoCalendario en lib/motorContexto.ts).
export function mapearEventosADiasNoLaborables(eventos: EventoCalendarioCompleto[]): DiaNoLaborable[] {
  const resultado: DiaNoLaborable[] = []
  const vistos = new Set<string>()
  for (const e of eventos) {
    if (!e.es_sep || vistos.has(e.fecha)) continue
    const t = (e.tipo || '').toLowerCase()
    let motivo: DiaNoLaborable['motivo'] | null = null
    if (t.includes('vacacion')) motivo = 'vacaciones'
    else if (t.includes('suspension') || t.includes('suspensión')) motivo = 'suspension'
    else if (t.includes('festiv')) motivo = 'dia_inhabil'
    else if (t.includes('cte') || t.includes('consejo')) motivo = 'evento_sin_clases'
    if (!motivo) continue
    vistos.add(e.fecha)
    resultado.push({ fecha: e.fecha, motivo, descripcion: e.titulo })
  }
  return resultado
}

export function resolverPeriodoEvaluacionActual(periodos: PeriodoEvaluacion[], hoy: string): PeriodoEvaluacion | null {
  return periodos.find((p) => p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= hoy && hoy <= p.fecha_fin) || null
}

// Patrones relativos resueltos de forma determinista en este paso:
// "después de vacaciones" → el día siguiente a la última vacación
// oficial SEP que empiece en o después de hoy; "inicio/regreso a
// clases" o "primeras semanas de clases" → el inicio oficial del
// ciclo escolar (nunca "hoy" — una planeación diagnóstica de inicio
// de ciclo pedida a mitad del ciclo debe seguir anclada al arranque
// real del ciclo, no a la fecha en que se pidió). Cualquier otra
// referencia relativa que el clasificador no pudo convertir en fecha
// se deja pasar tal cual como fechaReferencia=hoy (calcularFechasPlaneacion
// ya busca el siguiente día efectivo desde ahí) — nunca se bloquea, y
// el texto original se devuelve en `explicacionMomentoRelativo` para
// que el borrador lo mencione con honestidad en vez de fingir certeza.
const PATRON_INICIO_CICLO = /inicio de clases|primer d[ií]a de clases|comienzo (del |de )?(ciclo|curso)|regreso a clases|inicio del? ciclo escolar|inicio de ciclo|primeras?.*de clases/

// Espeja el default NO exportado de diasEfectivosPorSemana en
// calculoFechasHabiles.ts (DIAS_EFECTIVOS_POR_SEMANA_DEFAULT = 5) —
// usado ÚNICAMENTE para la validación fail-closed de los casos 7/8
// (fechaFin/fechaInicio+fechaFin junto con duracionSemanas explícita),
// NUNCA para alimentar al calculador (que sigue resolviendo su propio
// default internamente, sin cambios). Ningún llamador de este archivo
// pasa hoy un diasEfectivosPorSemana distinto; si eso cambiara en el
// futuro, esta constante tendría que actualizarse junto con esa
// decisión — no antes.
const DIAS_EFECTIVOS_POR_SEMANA_ASUMIDO = 5

function resolverFechaReferencia(
  momentoRelativo: string | null,
  eventos: EventoCalendarioCompleto[],
  hoy: string,
  inicioCiclo: string
): { fechaReferencia: string; explicacion: string | null } {
  if (!momentoRelativo) return { fechaReferencia: hoy, explicacion: null }

  const normalizado = momentoRelativo.toLowerCase()
  if (PATRON_INICIO_CICLO.test(normalizado)) {
    return {
      fechaReferencia: inicioCiclo,
      explicacion: `Se solicitó iniciar en "${momentoRelativo}" — se ubicó el inicio oficial del ciclo escolar (${inicioCiclo}) y se calculó a partir de ahí, ajustando al siguiente día efectivo si cae en fin de semana o día no laborable.`,
    }
  }
  if (normalizado.includes('vacacion')) {
    const vacacionesFuturas = eventos
      .filter((e) => e.es_sep && (e.tipo || '').toLowerCase().includes('vacacion') && e.fecha >= hoy)
      .sort((a, b) => (a.fecha < b.fecha ? 1 : -1)) // más reciente primero
    if (vacacionesFuturas.length > 0) {
      const ultimaFecha = vacacionesFuturas[0].fecha
      const [y, m, d] = ultimaFecha.split('-').map(Number)
      const siguiente = new Date(y, m - 1, d + 1)
      const fechaReferencia = `${siguiente.getFullYear()}-${String(siguiente.getMonth() + 1).padStart(2, '0')}-${String(siguiente.getDate()).padStart(2, '0')}`
      return { fechaReferencia, explicacion: `Se solicitó iniciar "después de vacaciones" — se ubicó el periodo de vacaciones más próximo en el calendario y se calculó a partir del día siguiente (${fechaReferencia}).` }
    }
    return { fechaReferencia: hoy, explicacion: 'Se solicitó iniciar "después de vacaciones", pero no se encontró un periodo de vacaciones registrado en el calendario a partir de hoy — se usó la fecha más próxima disponible.' }
  }

  return { fechaReferencia: hoy, explicacion: `Se solicitó iniciar "${momentoRelativo}" — no fue posible resolver esa referencia automáticamente contra el calendario; se usó la fecha más próxima disponible. Ajusta las fechas si no es lo que buscabas.` }
}

export async function prepararContextoGeneracionPlaneacion(
  sb: SupabaseClient,
  sesion: SesionContexto,
  solicitud: SolicitudGeneracionPlaneacion,
  snapshotHeredado?: PlaneacionActivaV3
): Promise<ResultadoContextoGeneracion> {
  const grupoId = sesion.grupo_activo_id!
  const anio = Number(sesion.fecha_actual.slice(0, 4))
  const mes = Number(sesion.fecha_actual.slice(5, 7))
  const inicioAnioCiclo = mes >= 8 ? anio : anio - 1
  const inicioCiclo = `${inicioAnioCiclo}-08-01`
  const finCiclo = `${inicioAnioCiclo + 1}-07-31`

  const [ctxGrupo, eventosCiclo, periodos, planeacionesPrevias, resultadoCurricular] = await Promise.all([
    contextoGrupo(sb, grupoId),
    calendarioCicloCompleto(sb, sesion.docente_id, inicioCiclo, finCiclo),
    sesion.ciclo_escolar_id ? periodosEvaluacionDelCiclo(sb, sesion.ciclo_escolar_id) : Promise.resolve<PeriodoEvaluacion[]>([]),
    listarPlaneaciones({ supabase: sb }, { grupo_id: grupoId }),
    // PLN-1C — 0 IA: solo SELECTs. Grupos sin Programa Analítico
    // publicado reciben disponible:false y el comportamiento queda
    // idéntico al anterior a PLN-1C (ver ResultadoContextoCurricularPlaneacion).
    prepararContextoCurricularPlaneacion(sb, grupoId, { tema: solicitud.tema }),
  ])

  const diasNoLaborables = mapearEventosADiasNoLaborables(eventosCiclo)
  const { fechaReferencia, explicacion: explicacionMomentoRelativo } = resolverFechaReferencia(solicitud.momentoRelativo, eventosCiclo, sesion.fecha_actual, inicioCiclo)

  // Fase 3B.3 — herencia de fechas/duración POR RESTRICCIONES (corrige
  // la regla TODO-O-NADA anterior, que perdía fechaInicio al cambiar
  // solo la duración, perdía la duración al cambiar solo fechaInicio,
  // fallaba con conflicto al cambiar solo fechaFin, e ignoraba en
  // silencio duracionSemanas explícita — ver auditoría "herencia
  // temporal de ajuste" aprobada por separado, verificada por
  // ejecución real contra calcularFechasPlaneacion, NUNCA
  // reimplementada aquí). calcularFechasPlaneacion() NO se modifica —
  // sigue siendo la única autoridad aritmética; este bloque solo decide
  // QUÉ argumentos recibe, agrupando por cuáles de las 4 señales
  // (fechaInicio/fechaFin/duracionDias/duracionSemanas) llegaron
  // explícitas en ESTE turno — nunca mezcladas campo por campo, que es
  // precisamente el error que ya se había detectado y corregido antes
  // para el caso "todo o nada".
  const tieneInicio = solicitud.fechaInicio != null
  const tieneFin = solicitud.fechaFin != null
  const tieneDuracionDias = solicitud.duracionDias != null
  const tieneDuracionSemanas = solicitud.duracionSemanas != null
  const tieneAlgunaDuracion = tieneDuracionDias || tieneDuracionSemanas

  let fechaInicioEfectiva = solicitud.fechaInicio
  let fechaFinEfectiva = solicitud.fechaFin
  let duracionDiasEfectiva = solicitud.duracionDias
  // Solo se llena en los casos 7/8 (fechaFin y/o fechaInicio explícitos
  // JUNTO con una duración explícita) — calcularFechasPlaneacion ya
  // ignora la duración por completo en cuanto recibe un rango completo
  // (fechaInicio && fechaFin), así que la duración explícita del
  // docente nunca llega a validarse por sí sola dentro del calculador.
  // Aquí se valida DESPUÉS, comparando el resultado real del rango
  // contra lo que el docente pidió explícitamente — nunca se elige
  // arbitrariamente entre fechaFin y duración, nunca se ignora
  // ninguna de las dos en silencio.
  let duracionExplicitaAValidar: number | null = null

  if (snapshotHeredado) {
    if (!tieneInicio && !tieneFin && !tieneAlgunaDuracion) {
      // CASO 1 — ninguna señal temporal: mantener exactamente la
      // temporalidad vigente.
      fechaInicioEfectiva = snapshotHeredado.borrador.fechaInicio
      fechaFinEfectiva = snapshotHeredado.borrador.fechaFin
      duracionDiasEfectiva = snapshotHeredado.borrador.duracionDias
    } else if (!tieneInicio && !tieneFin && tieneAlgunaDuracion) {
      // CASO 2 — solo duración (días o semanas): mismo inicio, nueva
      // duración → nuevo fin. NUNCA se hereda duracionDias si lo
      // explícito fue duracionSemanas (duracionDiasEfectiva/
      // solicitud.duracionSemanas ya vienen intactos, sin tocar).
      fechaInicioEfectiva = snapshotHeredado.borrador.fechaInicio
    } else if (tieneInicio && !tieneFin && !tieneAlgunaDuracion) {
      // CASO 3 — solo fechaInicio nueva: nuevo inicio + duración
      // vigente → nuevo fin.
      duracionDiasEfectiva = snapshotHeredado.borrador.duracionDias
    } else if (!tieneInicio && tieneFin && !tieneAlgunaDuracion) {
      // CASO 4 — solo fechaFin nueva: mantener el inicio, respetar el
      // fin nuevo tal cual (nunca imponer la duración vieja).
      fechaInicioEfectiva = snapshotHeredado.borrador.fechaInicio
    } else if (!tieneInicio && tieneFin && tieneAlgunaDuracion) {
      // CASO 7 — fechaFin + duración explícitas, sin fechaInicio:
      // calcularFechasPlaneacion no puede calcular hacia atrás desde
      // fechaFin, así que se hereda TENTATIVAMENTE el inicio vigente
      // para formar un rango literal (inicio heredado + fin
      // explícito) — y se valida después que la duración efectiva de
      // ese rango coincida con la duración explícita pedida.
      fechaInicioEfectiva = snapshotHeredado.borrador.fechaInicio
      duracionExplicitaAValidar = tieneDuracionDias
        ? solicitud.duracionDias
        : (solicitud.duracionSemanas as number) * DIAS_EFECTIVOS_POR_SEMANA_ASUMIDO
      duracionDiasEfectiva = null // nunca se envía al calculador en este caso — solo sirve para la validación posterior
    } else if (tieneInicio && tieneFin && tieneAlgunaDuracion) {
      // CASO 8 — las tres explícitas: calcularFechasPlaneacion ignora
      // la duración en cuanto recibe el rango completo, así que se
      // valida después que la duración efectiva del rango coincida
      // con la duración explícita — nunca se ignora en silencio.
      duracionExplicitaAValidar = tieneDuracionDias
        ? solicitud.duracionDias
        : (solicitud.duracionSemanas as number) * DIAS_EFECTIVOS_POR_SEMANA_ASUMIDO
      duracionDiasEfectiva = null
    }
    // CASO 5 (inicio+duración, sin fin) y CASO 6 (inicio+fin, sin
    // duración) no requieren herencia ni validación adicional: ya
    // traen lo necesario, mismo comportamiento que 'crear' hoy.
  }

  const fechas = calcularFechasPlaneacion({
    fechaInicio: fechaInicioEfectiva,
    fechaFin: fechaFinEfectiva,
    duracionDiasEfectivos: duracionDiasEfectiva,
    duracionSemanas: solicitud.duracionSemanas,
    diasNoLaborables,
    fechaReferencia,
  })

  // Validación fail-closed de los casos 7/8 — reutiliza el MISMO
  // mecanismo de conflicto ya existente (conflicto/explicacion, ya
  // consumido tal cual por instruccionesPlaneacionGenerar.ts, sin
  // segunda arquitectura de errores). Si el rango ya venía en
  // conflicto por su cuenta, se deja tal cual — no hay nada que
  // sobreescribir.
  const fechasFinal: ResultadoCalculoFechas =
    duracionExplicitaAValidar != null && !fechas.conflicto && fechas.totalDiasEfectivos !== duracionExplicitaAValidar
      ? {
          ...fechas,
          conflicto: true,
          explicacion: `La fecha de fin solicitada (${fechaFinEfectiva}) no es compatible con la duración solicitada (${duracionExplicitaAValidar} día(s) efectivo(s)) a partir del ${fechaInicioEfectiva}: ese rango tiene realmente ${fechas.totalDiasEfectivos} día(s) efectivo(s). Indica solo uno de los dos (la fecha de fin o la duración) para evitar la ambigüedad.`,
        }
      : fechas

  const periodoEvaluacionActual = resolverPeriodoEvaluacionActual(periodos, sesion.fecha_actual)

  const resumenPrevias: ResumenPlaneacionPrevia[] = planeacionesPrevias.ok
    ? planeacionesPrevias.datos.slice(0, 10).map((p) => ({
        nombre: p.nombre,
        periodo: periodos.find((per) => per.id === p.periodo_evaluacion_id)?.nombre || null,
        fechaInicio: p.fecha_inicio,
        fechaFin: p.fecha_fin,
      }))
    : []

  const eventosCalendarioDelPeriodo = fechasFinal.fechasExcluidas
    .filter((f) => f.motivo !== 'fin_de_semana')
    .map((f) => ({ fecha: f.fecha, titulo: f.descripcion || f.motivo, motivo: f.motivo }))

  return {
    contextoGrupo: ctxGrupo,
    fechas: fechasFinal,
    explicacionMomentoRelativo,
    periodoEvaluacionActual,
    planeacionesPrevias: resumenPrevias,
    eventosCalendarioDelPeriodo,
    planeacionVigente: snapshotHeredado
      ? { borrador: snapshotHeredado.borrador, contenidoCompleto: snapshotHeredado.contenidoCompleto }
      : null,
    contextoCurricularPlaneacion: resultadoCurricular.disponible ? resultadoCurricular.contexto : null,
  }
}
