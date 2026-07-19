// lib/tiempo/TimeService.ts
//
// Único lugar de toda la aplicación que calcula fecha, hora, día de la
// semana, saludo por hora y ciclo escolar. Nada más en el proyecto debe
// llamar a `new Date().toLocaleDateString(...)`, `getHours()` ni construir
// el ciclo escolar por su cuenta — todo pasa por aquí para garantizar que
// la hora que ve el docente en el chat, el calendario, las asistencias y
// cualquier función futura sea siempre la misma.
//
// REGLA CENTRAL: esta función NUNCA asume ni adivina una zona horaria.
// Siempre recibe la zona horaria real como parámetro explícito.
// - En el navegador, esa zona se obtiene con obtenerZonaHorariaDispositivo()
//   (Intl.DateTimeFormat().resolvedOptions().timeZone) — la zona real del
//   dispositivo del docente (ej. "America/Mazatlan"), no un valor fijo.
// - En una ruta de servidor (app/api/**), el servidor NO puede saber la
//   zona del dispositivo por su cuenta (Vercel corre en UTC) — por eso
//   cada endpoint que necesita la fecha/hora real la recibe en el cuerpo
//   de la petición (campo `zonaHoraria`, mandado por el cliente con
//   obtenerZonaHorariaDispositivo()) y se la pasa a este servicio.
//   Nunca calcules la fecha con `new Date()` a secas en un endpoint.
//
// El bug original que motivó este servicio: app/api/chat/route.ts tenía
// "America/Mexico_City" fijo en el código — para un docente en cualquier
// otra zona de México (Mazatlán, Tijuana, Cancún) eso producía desfases
// de hasta 2 horas en la hora que el asistente daba por buena.

export const ZONA_HORARIA_RESPALDO = 'America/Mexico_City'

// Única función de todo el proyecto que debe leer la zona horaria del
// dispositivo. Úsala en cualquier componente/servicio de cliente antes de
// llamar a obtenerFechaHora(), o antes de mandarla al servidor.
export function obtenerZonaHorariaDispositivo(): string {
  if (typeof Intl === 'undefined') return ZONA_HORARIA_RESPALDO
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || ZONA_HORARIA_RESPALDO
  } catch {
    return ZONA_HORARIA_RESPALDO
  }
}

export type InfoFechaHora = {
  zonaHoraria: string
  fechaISO: string // YYYY-MM-DD en la zona indicada — para comparar/guardar en base de datos
  fechaLegible: string // "18 de julio de 2026"
  horaLegible: string // "09:24", 24 horas
  diaSemana: string // "sábado"
  saludo: 'Buenos días' | 'Buenas tardes' | 'Buenas noches'
  cicloEscolar: string // "2026-2027"
  anio: number
  mes: number // 1-12
}

function partesEnZona(fecha: Date, zonaHoraria: string): Record<string, string> {
  const formateador = new Intl.DateTimeFormat('es-MX', {
    timeZone: zonaHoraria,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    // hourCycle explícito en vez de hour12 — algunos motores JS
    // devuelven "24:00" para medianoche con hour12:false, hourCycle:'h23'
    // es la forma robusta de pedir 00-23.
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'long',
  })
  const partes: Record<string, string> = {}
  for (const parte of formateador.formatToParts(fecha)) {
    if (parte.type !== 'literal') partes[parte.type] = parte.value
  }
  return partes
}

// Punto único de cálculo: dada una zona horaria real (nunca asumida) y,
// opcionalmente, un instante distinto a "ahora", regresa todo lo que
// cualquier función del Chat IA (hora, fecha, saludo, calendario,
// recordatorios, asistencias, bitácoras, sellos de tiempo) necesita.
export function obtenerFechaHora(zonaHoraria: string | null | undefined, fecha: Date = new Date()): InfoFechaHora {
  const zona = zonaHoraria || ZONA_HORARIA_RESPALDO
  let partes: Record<string, string>
  try {
    partes = partesEnZona(fecha, zona)
  } catch {
    // Zona horaria inválida/desconocida recibida del cliente — no
    // tronar la petición completa por eso, usar el respaldo.
    partes = partesEnZona(fecha, ZONA_HORARIA_RESPALDO)
  }

  const anio = Number(partes.year)
  const mes = Number(partes.month)
  const hora = Number(partes.hour)

  const fechaISO = `${partes.year}-${partes.month}-${partes.day}`
  const horaLegible = `${partes.hour}:${partes.minute}`
  const diaSemana = partes.weekday

  let saludo: InfoFechaHora['saludo']
  if (hora < 12) saludo = 'Buenos días'
  else if (hora < 19) saludo = 'Buenas tardes'
  else saludo = 'Buenas noches'

  // Ciclo escolar mexicano: agosto-julio. Antes de agosto sigue vigente
  // el ciclo que empezó el año anterior.
  const cicloEscolar = mes >= 8 ? `${anio}-${anio + 1}` : `${anio - 1}-${anio}`

  const fechaLegible = new Intl.DateTimeFormat('es-MX', {
    timeZone: zona,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(fecha)

  return { zonaHoraria: zona, fechaISO, fechaLegible, horaLegible, diaSemana, saludo, cicloEscolar, anio, mes }
}

// Atajo para "fecha ISO de hoy en esta zona" — el reemplazo directo de
// `new Date().toISOString().slice(0, 10)`, que en un servidor corriendo
// en UTC puede estar hasta un día adelantado respecto al día real del
// docente (ej. las 6pm en Mazatlán, UTC-7, ya son la 1am del día
// siguiente en UTC).
export function fechaISOHoy(zonaHoraria: string | null | undefined, fecha: Date = new Date()): string {
  return obtenerFechaHora(zonaHoraria, fecha).fechaISO
}

// Formatea una fecha YA GUARDADA (ej. "2026-07-18" de una fila de
// asistencia, o el created_at de un documento) para mostrarla en la
// interfaz — mismo criterio de zona horaria que el resto del servicio,
// para que una fecha guardada y la fecha "de hoy" con la que se compara
// nunca queden desalineadas por usar reglas distintas.
export function formatearFecha(
  fechaEntrada: string | Date,
  zonaHoraria: string | null | undefined,
  opciones: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }
): string {
  const zona = zonaHoraria || ZONA_HORARIA_RESPALDO
  const fecha = typeof fechaEntrada === 'string'
    ? new Date(fechaEntrada.includes('T') ? fechaEntrada : `${fechaEntrada}T12:00:00`)
    : fechaEntrada
  try {
    return new Intl.DateTimeFormat('es-MX', { ...opciones, timeZone: zona }).format(fecha)
  } catch {
    return new Intl.DateTimeFormat('es-MX', { ...opciones, timeZone: ZONA_HORARIA_RESPALDO }).format(fecha)
  }
}
