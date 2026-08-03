// lib/planeacion/calculoFechasHabiles.ts
//
// Utilidad AISLADA y determinista para resolver las fechas de una
// planeación pedida al Chat IA ("dos semanas", "del 10 al 21 de
// agosto", "10 días efectivos"...). No consulta Supabase, no importa
// nada de app/, no depende de texto generado por IA — quien llame a
// esta función ya debe traer los días no laborables normalizados
// (festivos/suspensiones/vacaciones/eventos, ver DiaNoLaborable) y la
// fecha de "hoy" ya resuelta con la zona horaria real (reutilizar
// fechaISOHoy() de lib/tiempo/TimeService.ts en el punto de llamada,
// nunca reimplementar esa resolución aquí — mantiene esta función
// pura y 100% reproducible en pruebas).
//
// Todas las fechas son strings 'YYYY-MM-DD'. La aritmética de
// calendario se hace con Date en hora LOCAL (nunca ISO/UTC) para no
// repetir el mismo bug de "día equivocado cerca de medianoche" ya
// documentado en lib/motorContexto.ts — aquí ni siquiera aplica
// medianoche real porque nunca se usa la hora del sistema, solo
// aritmética de días naturales sobre fechas ya dadas.

export type MotivoExclusion = 'fin_de_semana' | 'dia_inhabil' | 'suspension' | 'vacaciones' | 'evento_sin_clases'

export type DiaNoLaborable = {
  fecha: string // YYYY-MM-DD
  motivo: Exclude<MotivoExclusion, 'fin_de_semana'>
  descripcion?: string
}

export type FechaExcluida = {
  fecha: string
  motivo: MotivoExclusion
  descripcion?: string
}

export type ParametrosCalculoFechas = {
  fechaInicio?: string | null
  fechaFin?: string | null
  duracionDiasEfectivos?: number | null
  duracionSemanas?: number | null
  diasEfectivosPorSemana?: number
  diasNoLaborables: DiaNoLaborable[]
  diasFinDeSemana?: number[]
  fechaReferencia: string
  zonaHoraria?: string
}

export type ResultadoCalculoFechas = {
  fechaInicioResuelta: string | null
  fechaFinResuelta: string | null
  totalDiasNaturales: number
  totalDiasEfectivos: number
  diasEfectivos: string[]
  fechasExcluidas: FechaExcluida[]
  advertencias: string[]
  conflicto: boolean
  explicacion: string
}

const DIAS_FIN_DE_SEMANA_DEFAULT = [0, 6] // domingo, sábado
const DIAS_EFECTIVOS_POR_SEMANA_DEFAULT = 5
// Ventana máxima de búsqueda hacia adelante — evita un bucle
// prácticamente infinito si diasNoLaborables cubre un tramo absurdo
// (ej. un año entero marcado como suspensión por error de quien llama).
const LIMITE_DIAS_NATURALES_BUSQUEDA = 400

function parsearFecha(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatearFechaISO(fecha: Date): string {
  const y = fecha.getFullYear()
  const m = String(fecha.getMonth() + 1).padStart(2, '0')
  const d = String(fecha.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function sumarDias(fecha: Date, n: number): Date {
  const copia = new Date(fecha)
  copia.setDate(copia.getDate() + n)
  return copia
}

function diferenciaDias(a: Date, b: Date): number {
  const MS_POR_DIA = 24 * 60 * 60 * 1000
  return Math.round((b.getTime() - a.getTime()) / MS_POR_DIA)
}

function motivoNoLaborable(
  fechaISO: string,
  diaSemana: number,
  diasFinDeSemana: number[],
  mapaNoLaborables: Map<string, DiaNoLaborable>
): { motivo: MotivoExclusion; descripcion?: string } | null {
  const entrada = mapaNoLaborables.get(fechaISO)
  if (entrada) return { motivo: entrada.motivo, descripcion: entrada.descripcion }
  if (diasFinDeSemana.includes(diaSemana)) return { motivo: 'fin_de_semana' }
  return null
}

export function calcularFechasPlaneacion(params: ParametrosCalculoFechas): ResultadoCalculoFechas {
  const diasFinDeSemana = params.diasFinDeSemana ?? DIAS_FIN_DE_SEMANA_DEFAULT
  const diasEfectivosPorSemana = params.diasEfectivosPorSemana ?? DIAS_EFECTIVOS_POR_SEMANA_DEFAULT
  const mapaNoLaborables = new Map(params.diasNoLaborables.map(d => [d.fecha, d]))
  const advertencias: string[] = []

  const vacio = (explicacion: string, conflicto = true): ResultadoCalculoFechas => ({
    fechaInicioResuelta: null,
    fechaFinResuelta: null,
    totalDiasNaturales: 0,
    totalDiasEfectivos: 0,
    diasEfectivos: [],
    fechasExcluidas: [],
    advertencias,
    conflicto,
    explicacion,
  })

  // Duración resuelta a días efectivos, sin importar si vino como
  // semanas o directa — regla 6 ("dos semanas" = 10 días efectivos por
  // defecto la resuelve QUIEN LLAMA pasando duracionSemanas: 2; esta
  // función solo multiplica por diasEfectivosPorSemana, nunca
  // interpreta lenguaje natural).
  let duracionResuelta: number | null = null
  if (params.duracionDiasEfectivos != null) {
    duracionResuelta = params.duracionDiasEfectivos
  } else if (params.duracionSemanas != null) {
    duracionResuelta = params.duracionSemanas * diasEfectivosPorSemana
  }

  // Regla 11 — duración cero o negativa: no calcular, reportar conflicto.
  if (duracionResuelta != null && duracionResuelta <= 0) {
    return vacio(`La duración solicitada (${duracionResuelta} días efectivos) debe ser mayor a cero.`)
  }

  // --- Caso: fecha inicial Y fecha final dadas (regla 2) ---
  if (params.fechaInicio && params.fechaFin) {
    const inicio = parsearFecha(params.fechaInicio)
    const fin = parsearFecha(params.fechaFin)

    // Regla 10 — fecha final anterior a la inicial.
    if (fin.getTime() < inicio.getTime()) {
      advertencias.push(`La fecha final (${params.fechaFin}) es anterior a la inicial (${params.fechaInicio}).`)
      return vacio(`No se puede calcular: la fecha final (${params.fechaFin}) es anterior a la fecha inicial (${params.fechaInicio}).`)
    }

    const totalDiasNaturales = diferenciaDias(inicio, fin) + 1
    const diasEfectivos: string[] = []
    const fechasExcluidas: FechaExcluida[] = []

    for (let i = 0; i < totalDiasNaturales; i++) {
      const dia = sumarDias(inicio, i)
      const iso = formatearFechaISO(dia)
      const excluido = motivoNoLaborable(iso, dia.getDay(), diasFinDeSemana, mapaNoLaborables)
      if (excluido) {
        fechasExcluidas.push({ fecha: iso, ...excluido })
      } else {
        diasEfectivos.push(iso)
      }
    }

    // Regla 9 — rango sin ningún día efectivo.
    if (diasEfectivos.length === 0) {
      advertencias.push('El periodo indicado no contiene ningún día efectivo de clase.')
      return {
        fechaInicioResuelta: params.fechaInicio,
        fechaFinResuelta: params.fechaFin,
        totalDiasNaturales,
        totalDiasEfectivos: 0,
        diasEfectivos: [],
        fechasExcluidas,
        advertencias,
        conflicto: true,
        explicacion: `Del ${params.fechaInicio} al ${params.fechaFin} no hay ningún día efectivo de clase (${fechasExcluidas.length} día(s) excluido(s)).`,
      }
    }

    return {
      fechaInicioResuelta: params.fechaInicio,
      fechaFinResuelta: params.fechaFin,
      totalDiasNaturales,
      totalDiasEfectivos: diasEfectivos.length,
      diasEfectivos,
      fechasExcluidas,
      advertencias,
      conflicto: false,
      explicacion: `Del ${params.fechaInicio} al ${params.fechaFin} (${totalDiasNaturales} días naturales) hay ${diasEfectivos.length} día(s) efectivo(s) de clase; se excluyeron ${fechasExcluidas.length}.`,
    }
  }

  // --- A partir de aquí: se necesita una duración (reglas 1 y 3) ---
  if (duracionResuelta == null) {
    return vacio('No se indicó fecha final ni duración — no hay suficiente información para calcular el periodo.')
  }

  // Punto de partida: fechaInicio si se dio (regla 1), o el siguiente
  // día efectivo disponible desde fechaReferencia (regla 3).
  const inicioBuscado = parsearFecha(params.fechaInicio || params.fechaReferencia)
  let fechaInicioResuelta: Date | null = null

  for (let i = 0; i < LIMITE_DIAS_NATURALES_BUSQUEDA; i++) {
    const candidato = sumarDias(inicioBuscado, i)
    const iso = formatearFechaISO(candidato)
    const excluido = motivoNoLaborable(iso, candidato.getDay(), diasFinDeSemana, mapaNoLaborables)
    if (!excluido) {
      fechaInicioResuelta = candidato
      if (i > 0 && params.fechaInicio) {
        // Regla 4 — la fecha inicial pedida cayó en día no laborable.
        advertencias.push(`La fecha inicial solicitada (${params.fechaInicio}) no es un día efectivo de clase; se movió al siguiente día efectivo disponible (${iso}).`)
      }
      break
    }
  }

  if (!fechaInicioResuelta) {
    return vacio(`No se encontró ningún día efectivo de clase dentro de una ventana de ${LIMITE_DIAS_NATURALES_BUSQUEDA} días naturales a partir de ${formatearFechaISO(inicioBuscado)} — revisa los días no laborables proporcionados.`)
  }

  // Regla 5 — recorrer hacia adelante contando días efectivos,
  // extendiendo automáticamente sobre vacaciones/suspensiones.
  const diasEfectivos: string[] = []
  const fechasExcluidas: FechaExcluida[] = []
  let ultimaFecha: Date = fechaInicioResuelta
  let encontrados = 0

  for (let i = 0; encontrados < duracionResuelta && i < LIMITE_DIAS_NATURALES_BUSQUEDA; i++) {
    const dia = sumarDias(fechaInicioResuelta, i)
    const iso = formatearFechaISO(dia)
    const excluido = motivoNoLaborable(iso, dia.getDay(), diasFinDeSemana, mapaNoLaborables)
    if (excluido) {
      fechasExcluidas.push({ fecha: iso, ...excluido })
    } else {
      diasEfectivos.push(iso)
      encontrados++
    }
    ultimaFecha = dia
  }

  if (encontrados < duracionResuelta) {
    advertencias.push(`Solo se encontraron ${encontrados} de ${duracionResuelta} días efectivos solicitados dentro de la ventana de búsqueda disponible.`)
    return {
      fechaInicioResuelta: formatearFechaISO(fechaInicioResuelta),
      fechaFinResuelta: formatearFechaISO(ultimaFecha),
      totalDiasNaturales: diferenciaDias(fechaInicioResuelta, ultimaFecha) + 1,
      totalDiasEfectivos: encontrados,
      diasEfectivos,
      fechasExcluidas,
      advertencias,
      conflicto: true,
      explicacion: `No fue posible completar los ${duracionResuelta} días efectivos solicitados; solo se encontraron ${encontrados}.`,
    }
  }

  const fechaFinResuelta = parsearFecha(diasEfectivos[diasEfectivos.length - 1])
  const totalDiasNaturales = diferenciaDias(fechaInicioResuelta, fechaFinResuelta) + 1

  return {
    fechaInicioResuelta: formatearFechaISO(fechaInicioResuelta),
    fechaFinResuelta: formatearFechaISO(fechaFinResuelta),
    totalDiasNaturales,
    totalDiasEfectivos: diasEfectivos.length,
    diasEfectivos,
    fechasExcluidas,
    advertencias,
    conflicto: false,
    explicacion: `Se solicitaron ${duracionResuelta} días efectivos de clase a partir del ${formatearFechaISO(fechaInicioResuelta)}. Se excluyeron ${fechasExcluidas.length} día(s) (${Array.from(new Set(fechasExcluidas.map(f => f.motivo))).join(', ') || 'ninguno'}). El periodo resultante va del ${formatearFechaISO(fechaInicioResuelta)} al ${formatearFechaISO(fechaFinResuelta)}.`,
  }
}
