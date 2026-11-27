// lib/seguimiento/consultaHistorial.ts
//
// Hito 3d — consultas del Chat IA sobre el historial académico. Sin IA:
//   - lee del texto (reglas fijas) el periodo, el campo formativo o el
//     proyecto pedidos, solo contra datos reales (periodos del ciclo,
//     campos oficiales, proyectos confirmados del grupo);
//   - redacta respuestas compactas desde el MISMO modelo de lectura que la
//     ficha y el concentrado: niveles reales, «Requiere apoyo»,
//     «Sin evaluar» y «Sin registro» separados; nunca calificaciones,
//     promedios, observaciones ni conclusiones; si falta información, lo
//     dice;
//   - arma el bloque de resultados confirmados para la ficha descriptiva
//     (mismo llamado de IA de siempre, más datos reales).

import { CAMPOS_FORMATIVOS } from './tipos'
import { ETIQUETA_NIVEL_CANONICO, ORDEN_NIVELES_CANONICOS, type NivelTextoCanonico } from './conversionCalificacion'
import { cumpleFiltro, type ConcentradoGrupo, type FiltroHistorial, type HistorialAlumno, type InscripcionEnHistorialAlumno, type PeriodoPresente, type ProyectoHistorialGrupo } from './historialGrupo'

const normalizar = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim()

// ------------------------------------------------------------------
// Lectura del pedido (determinista)
// ------------------------------------------------------------------
const ORDINALES: [RegExp, number][] = [
  [/\b(primer|primero|1er|1o|1)\b/, 1],
  [/\b(segundo|2do|2o|2)\b/, 2],
  [/\b(tercer|tercero|3er|3o|3)\b/, 3],
  [/\b(cuarto|4to|4o|4)\b/, 4],
]
const PALABRA_PERIODO = /\b(trimestre|periodo|bimestre|cuatrimestre|semestre)\b/

export type PeriodoPedido = { tipo: 'ninguno' } | { tipo: 'encontrado'; periodo: PeriodoPresente } | { tipo: 'sin_periodo' } | { tipo: 'no_existe'; texto: string }

type PeriodoDelCiclo = { id: string; nombre: string; numero_periodo: number; fecha_inicio?: string | null; fecha_fin?: string | null }
const presente = (p: PeriodoDelCiclo): PeriodoPedido => ({ tipo: 'encontrado', periodo: { id: p.id, nombre: p.nombre, numero: p.numero_periodo } })

// hoy (YYYY-MM-DD): para «este trimestre / periodo actual».
export function periodoEnTexto(texto: string, periodos: PeriodoDelCiclo[], hoy?: string): PeriodoPedido {
  const t = normalizar(texto)
  if (/\bsin periodo\b/.test(t)) return { tipo: 'sin_periodo' }
  const porNombre = periodos.filter((p) => t.includes(normalizar(p.nombre)))
  if (porNombre.length === 1) return presente(porNombre[0])
  const m = t.match(new RegExp(`(\\S+)\\s+${PALABRA_PERIODO.source}|${PALABRA_PERIODO.source}\\s+(\\S+)`))
  if (!m) return { tipo: 'ninguno' }
  const frase = m[0]
  if (/\b(este|esta|actual)\b/.test(frase) || /\b(trimestre|periodo|bimestre) actual\b/.test(t)) {
    const actuales = hoy ? periodos.filter((p) => p.fecha_inicio && p.fecha_fin && p.fecha_inicio <= hoy && hoy <= p.fecha_fin) : []
    return actuales.length === 1 ? presente(actuales[0]) : { tipo: 'no_existe', texto: frase }
  }
  const numero = ORDINALES.find(([re]) => re.test(m[1] ?? m[4] ?? ''))?.[1]
  if (!numero) return { tipo: 'ninguno' } // «por periodo», «cada trimestre»: sin filtro
  const p = periodos.filter((x) => x.numero_periodo === numero)
  return p.length === 1 ? presente(p[0]) : { tipo: 'no_existe', texto: frase }
}

// Solo palabras que identifican un campo sin ambigüedad (nunca
// «matemáticas», que no es un campo formativo).
const CLAVES_CAMPO: [RegExp, (typeof CAMPOS_FORMATIVOS)[number]][] = [
  [/\blenguajes?\b/, 'Lenguajes'],
  [/\bsaberes\b|\bpensamiento cientifico\b/, 'Saberes y Pensamiento Científico'],
  [/\betica\b|\bnaturaleza y sociedad(es)?\b/, 'Ética, Naturaleza y Sociedades'],
  [/\bde lo humano\b|\blo comunitario\b|\bhumano y (lo )?comunitario\b/, 'De lo Humano y lo Comunitario'],
]
export function campoEnTexto(texto: string): string | null {
  const t = normalizar(texto)
  const encontrados = [...new Set(CLAVES_CAMPO.filter(([re]) => re.test(t)).map(([, c]) => c))]
  return encontrados.length === 1 ? encontrados[0] : null
}

const VACIAS = new Set(['para', 'como', 'desde', 'sobre', 'entre', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'propios', 'propias', 'proyecto', 'elaboracion'])
const significativas = (t: string) => normalizar(t).split(' ').filter((w) => w.length >= 4 && !VACIAS.has(w))

// Proyecto nombrado en el mensaje: al menos 2 palabras significativas de
// su nombre presentes. Varias coincidencias empatadas = ambiguo.
export type ProyectoPedido = { tipo: 'ninguno' } | { tipo: 'encontrado'; proyecto: ProyectoHistorialGrupo } | { tipo: 'ambiguo'; opciones: ProyectoHistorialGrupo[] }
export function proyectoEnTexto(texto: string, proyectos: ProyectoHistorialGrupo[]): ProyectoPedido {
  const palabras = new Set(significativas(texto))
  const puntuados = proyectos.map((p) => ({ p, n: significativas(p.nombre ?? '').filter((w) => palabras.has(w)).length })).filter((x) => x.n >= 2)
  if (!puntuados.length) return { tipo: 'ninguno' }
  const max = Math.max(...puntuados.map((x) => x.n))
  const mejores = puntuados.filter((x) => x.n === max).map((x) => x.p)
  return mejores.length === 1 ? { tipo: 'encontrado', proyecto: mejores[0] } : { tipo: 'ambiguo', opciones: mejores }
}

// ------------------------------------------------------------------
// Redacción (determinista)
// ------------------------------------------------------------------
export function textoDistribucion(d: Record<NivelTextoCanonico, number>): string {
  return ORDEN_NIVELES_CANONICOS.filter((n) => d[n] > 0).map((n) => `${d[n]} ${ETIQUETA_NIVEL_CANONICO[n]}`).join(' · ') || 'sin indicadores'
}
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`

export function textoFiltro(filtro: FiltroHistorial, etiquetas: { periodo?: string; campo?: string; proyecto?: string }): string {
  const partes = [
    filtro.periodoId === 'sin_periodo' ? 'sin periodo asignado' : etiquetas.periodo ? `del ${etiquetas.periodo}` : null,
    etiquetas.campo ? `en ${etiquetas.campo}` : null,
    etiquetas.proyecto ? `del proyecto «${etiquetas.proyecto}»` : null,
  ].filter(Boolean)
  return partes.length ? ` ${partes.join(' ')}` : ''
}

// Respuesta grupal (concentrado ya filtrado).
export function textoResultadosGrupo(c: ConcentradoGrupo, grupo: string | null, filtroTexto: string, voz = false): string {
  const titulo = `Resultados confirmados${grupo ? ` de ${grupo}` : ''}${filtroTexto}`
  if (!c.proyectos.length) return `${titulo}: todavía no hay proyectos con resultados confirmados${filtroTexto ? ' con ese criterio' : ''}. Los resultados aparecen aquí cuando confirmas una hoja de evaluación.`
  const lineas = [`${titulo} — ${plural(c.proyectos.length, 'proyecto', 'proyectos')}, ${plural(c.alumnos.length, 'alumno', 'alumnos')}:`, `• Niveles: ${textoDistribucion(c.distribucion)}.`]
  if (c.indicadoresRequierenApoyo === 0) lineas.push('• Ningún indicador confirmado en Requiere apoyo.')
  else {
    lineas.push(`• ${plural(c.indicadoresRequierenApoyo, 'indicador confirmado', 'indicadores confirmados')} en Requiere apoyo (${plural(c.alumnosConIndicadoresEnApoyo, 'alumno', 'alumnos')}):`)
    const nombres = new Map(c.proyectos.map((p) => [p.proyecto.proyectoId, p.proyecto.nombre ?? 'Proyecto']))
    for (const a of c.alumnos.filter((x) => x.apoyo.length)) {
      lineas.push(voz ? `  – ${a.inscripcion.nombre}: ${plural(a.apoyo.length, 'indicador', 'indicadores')}` : `  – ${a.inscripcion.nombre}: ${a.apoyo.map((x) => `${c.proyectos.length > 1 ? `${nombres.get(x.proyectoId)}, ` : ''}${x.indicadorNumero}. ${x.indicadorEspecifico}`).join('; ')}`)
    }
  }
  const sinEvaluar = c.distribucion.no_evaluado
  if (sinEvaluar) lineas.push(`• ${plural(sinEvaluar, 'indicador quedó', 'indicadores quedaron')} Sin evaluar (sin marca en la hoja).`)
  const sinRegistro = c.alumnos.filter((a) => a.sinRegistro > 0).length
  if (sinRegistro) lineas.push(`• ${plural(sinRegistro, 'alumno activo no tiene', 'alumnos activos no tienen')} registro en al menos un proyecto.`)
  if (c.proyectos.some((p) => !p.proyecto.periodo) && !filtroTexto.includes('sin periodo')) lineas.push(`• ${plural(c.proyectos.filter((p) => !p.proyecto.periodo).length, 'proyecto está', 'proyectos están')} sin periodo asignado.`)
  if (!voz && c.proyectos.length > 1) lineas.push(`Proyectos: ${c.proyectos.map((p) => `${p.proyecto.nombre ?? 'Proyecto'} (${textoDistribucion(p.distribucion)})`).join('; ')}.`)
  lineas.push('El detalle por alumno y por proyecto está en Evaluación › Concentrado.')
  return lineas.join('\n')
}

// Inscripción del alumno en el grupo y ciclo activos (separación estricta).
export function inscripcionActiva(h: HistorialAlumno, grupoId: string, cicloId: string): InscripcionEnHistorialAlumno | null {
  return h.ciclos.flatMap((c) => c.inscripciones).find((i) => i.inscripcion.grupoId === grupoId && i.inscripcion.cicloEscolarId === cicloId) ?? null
}

// Respuesta individual (solo la inscripción del grupo activo, ya filtrada).
export function textoResultadosAlumno(nombre: string, ins: InscripcionEnHistorialAlumno | null, filtro: FiltroHistorial, filtroTexto: string, voz = false): string {
  const items = (ins?.periodos ?? []).flatMap((g) => g.proyectos).filter((x) => cumpleFiltro(x.proyecto, filtro))
  const con = items.filter((x) => x.estado === 'con_resultados')
  const sinRegistro = items.filter((x) => x.estado === 'sin_registro')
  if (!con.length) {
    return sinRegistro.length
      ? `${nombre} no tiene resultados confirmados${filtroTexto}: hay ${plural(sinRegistro.length, 'proyecto confirmado', 'proyectos confirmados')} del grupo sin registro suyo (${sinRegistro.map((x) => x.proyecto.nombre ?? 'Proyecto').join(', ')}).`
      : `${nombre} todavía no tiene resultados confirmados${filtroTexto} en su grupo actual. Aparecerán cuando confirmes una hoja de evaluación que lo incluya.`
  }
  const lineas = [`${nombre} — ${plural(con.length, 'proyecto con resultados confirmados', 'proyectos con resultados confirmados')}${filtroTexto}:`]
  const apoyo: string[] = []
  const enProceso: string[] = []
  for (const x of con) {
    if (x.estado !== 'con_resultados') continue
    lineas.push(`• ${x.proyecto.nombre ?? 'Proyecto'} (${x.proyecto.periodo?.nombre ?? 'sin periodo asignado'}): ${textoDistribucion(x.distribucion)}.`)
    for (const i of x.resultado.indicadores) {
      const etiqueta = `${con.length > 1 ? `${x.proyecto.nombre ?? 'Proyecto'}, ` : ''}${i.indicadorNumero}. ${i.indicadorEspecifico}`
      if (i.nivel === 'requiere_apoyo') apoyo.push(etiqueta)
      if (i.nivel === 'en_proceso') enProceso.push(etiqueta)
    }
  }
  if (apoyo.length) lineas.push(voz ? `Tiene ${plural(apoyo.length, 'indicador confirmado', 'indicadores confirmados')} en Requiere apoyo.` : `Indicadores confirmados en Requiere apoyo:\n${apoyo.map((a) => `  – ${a}`).join('\n')}`)
  else lineas.push('Ningún indicador confirmado en Requiere apoyo.')
  if (enProceso.length && !voz) lineas.push(`Indicadores confirmados En proceso:\n${enProceso.map((a) => `  – ${a}`).join('\n')}`)
  const sinEvaluar = con.reduce((s, x) => s + (x.estado === 'con_resultados' ? x.resultado.conteo.sinEvaluar : 0), 0)
  if (sinEvaluar) lineas.push(`${plural(sinEvaluar, 'indicador quedó', 'indicadores quedaron')} Sin evaluar (sin marca en la hoja).`)
  if (sinRegistro.length) lineas.push(`Sin registro en: ${sinRegistro.map((x) => x.proyecto.nombre ?? 'Proyecto').join(', ')}.`)
  return lineas.join('\n')
}

// Bloque de datos reales para la ficha descriptiva (contexto del mismo
// llamado de IA). Solo hechos: proyectos, periodos, niveles e indicadores.
export function contextoFichaDescriptiva(h: HistorialAlumno, grupoId: string | null, cicloId: string | null): string {
  const ins = grupoId && cicloId ? inscripcionActiva(h, grupoId, cicloId) : null
  const items = (ins?.periodos ?? []).flatMap((g) => g.proyectos)
  const con = items.filter((x) => x.estado === 'con_resultados')
  const encabezado = 'RESULTADOS ACADÉMICOS CONFIRMADOS (hojas de evaluación; niveles reales, sin calificación numérica ni promedio — no inventes otros, no los conviertas en calificaciones):'
  if (!con.length) return `${encabezado}\nNo hay resultados confirmados en el grupo y ciclo actuales. Dilo con naturalidad si la ficha lo requiere; no supongas desempeño.`
  const lineas = [encabezado]
  for (const x of con) {
    if (x.estado !== 'con_resultados') continue
    lineas.push(`- Proyecto «${x.proyecto.nombre ?? 'Proyecto'}» (${x.proyecto.periodo?.nombre ?? 'sin periodo asignado'}; ${x.proyecto.camposFormativos.join(', ') || 'campo no registrado'}): ${textoDistribucion(x.distribucion)}.`)
    for (const i of x.resultado.indicadores) lineas.push(`  · ${i.indicadorNumero}. ${i.indicadorEspecifico} — ${ETIQUETA_NIVEL_CANONICO[i.nivel]}`)
  }
  const sinRegistro = items.filter((x) => x.estado === 'sin_registro')
  if (sinRegistro.length) lineas.push(`- Sin registro (no tiene resultados) en: ${sinRegistro.map((x) => x.proyecto.nombre ?? 'Proyecto').join(', ')}.`)
  lineas.push('«Sin evaluar» significa que la hoja no tiene marca en ese indicador: no es un nivel de desempeño.')
  return lineas.join('\n')
}

// «Este alumno»: el que el docente tiene abierto (la ficha envía
// «Alumno seleccionado: <nombre>» en el contexto de pantalla), solo si
// coincide EXACTAMENTE con un único alumno del grupo activo.
export function alumnoEnPantallaDelGrupo(contexto: unknown, alumnos: { alumno_id: string; nombre_completo: string }[]): { alumno_id: string; nombre: string } | null {
  const m = typeof contexto === 'string' ? contexto.match(/^Alumno seleccionado: (.+)$/m) : null
  if (!m) return null
  const buscado = normalizar(m[1])
  const coinciden = alumnos.filter((a) => normalizar(a.nombre_completo) === buscado)
  return coinciden.length === 1 ? { alumno_id: coinciden[0].alumno_id, nombre: coinciden[0].nombre_completo } : null
}
