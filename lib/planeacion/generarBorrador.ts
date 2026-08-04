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
  solicitud: SolicitudGeneracionPlaneacion
): Promise<ResultadoContextoGeneracion> {
  const grupoId = sesion.grupo_activo_id!
  const anio = Number(sesion.fecha_actual.slice(0, 4))
  const mes = Number(sesion.fecha_actual.slice(5, 7))
  const inicioAnioCiclo = mes >= 8 ? anio : anio - 1
  const inicioCiclo = `${inicioAnioCiclo}-08-01`
  const finCiclo = `${inicioAnioCiclo + 1}-07-31`

  const [ctxGrupo, eventosCiclo, periodos, planeacionesPrevias] = await Promise.all([
    contextoGrupo(sb, grupoId),
    calendarioCicloCompleto(sb, sesion.docente_id, inicioCiclo, finCiclo),
    sesion.ciclo_escolar_id ? periodosEvaluacionDelCiclo(sb, sesion.ciclo_escolar_id) : Promise.resolve<PeriodoEvaluacion[]>([]),
    listarPlaneaciones({ supabase: sb }, { grupo_id: grupoId }),
  ])

  const diasNoLaborables = mapearEventosADiasNoLaborables(eventosCiclo)
  const { fechaReferencia, explicacion: explicacionMomentoRelativo } = resolverFechaReferencia(solicitud.momentoRelativo, eventosCiclo, sesion.fecha_actual, inicioCiclo)

  const fechas = calcularFechasPlaneacion({
    fechaInicio: solicitud.fechaInicio,
    fechaFin: solicitud.fechaFin,
    duracionDiasEfectivos: solicitud.duracionDias,
    duracionSemanas: solicitud.duracionSemanas,
    diasNoLaborables,
    fechaReferencia,
  })

  const periodoEvaluacionActual = resolverPeriodoEvaluacionActual(periodos, sesion.fecha_actual)

  const resumenPrevias: ResumenPlaneacionPrevia[] = planeacionesPrevias.ok
    ? planeacionesPrevias.datos.slice(0, 10).map((p) => ({
        nombre: p.nombre,
        periodo: periodos.find((per) => per.id === p.periodo_evaluacion_id)?.nombre || null,
        fechaInicio: p.fecha_inicio,
        fechaFin: p.fecha_fin,
      }))
    : []

  const eventosCalendarioDelPeriodo = fechas.fechasExcluidas
    .filter((f) => f.motivo !== 'fin_de_semana')
    .map((f) => ({ fecha: f.fecha, titulo: f.descripcion || f.motivo, motivo: f.motivo }))

  return {
    contextoGrupo: ctxGrupo,
    fechas,
    explicacionMomentoRelativo,
    periodoEvaluacionActual,
    planeacionesPrevias: resumenPrevias,
    eventosCalendarioDelPeriodo,
  }
}
