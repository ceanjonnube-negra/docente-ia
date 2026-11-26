// lib/planeacion/modificarPlaneacion.ts
//
// Hito 2, etapa 3a — ajuste conversacional de una planeación GUARDADA.
// Produce un BORRADOR (nunca toca la planeación aprobada, su proyecto ni su
// evaluación); su publicación como versión N+1 está en aprobarAjuste.ts (3b).
//
// - Base: la versión VIGENTE completa (planeacion_versiones: texto,
//   estructura y trazabilidad), nunca el texto que mande el cliente.
// - Una sola llamada de IA (el flujo de borrador de siempre) con la base y
//   la instrucción; sin clasificador.
// - Conservación determinista: por secciones del texto (encabezado,
//   propósito, contenidos y PDA, materiales, cada día, producto final) y
//   por campos del resumen. Lo que la instrucción no menciona se restaura
//   desde la base cuando la estructura coincide; si la instrucción es
//   global o la estructura cambió, no se restaura nada y el resumen de
//   cambios lista todas las diferencias reales.
// - Identidad del ajuste: metadata del servidor en
//   conversaciones_chat.planeacion_activa.ajustes (planeación, versión
//   base, grupo y huella del borrador), más una línea en el bloque de
//   resumen como respaldo. Ninguno de los dos basta para aprobarlo como
//   planeación NUEVA: un borrador de ajuste nunca se guarda como otra
//   planeación.

import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ETIQUETA_AJUSTE, ETIQUETA_INICIO_BLOQUE, extraerResumenBorrador, type ResumenBorrador } from './extraerBorrador'
import type { Planeacion } from './tipos'
import { diferirAjusteAlTurno } from '../chat/contextoTurno'

// ------------------------------------------------------------------
// Base canónica
// ------------------------------------------------------------------
export type EstructuraVersion = {
  planeacion?: { nombre?: string | null; proposito?: string | null; fecha_inicio?: string | null; fecha_fin?: string | null; campo_formativo?: string | null }
  proyecto?: {
    nombre?: string | null; campos_formativos?: string[] | null; contenidos?: string[] | null; pda?: string[] | null; ejes_articuladores?: string[] | null
    metodologia?: string | null; duracion_dias?: number | null; actividades?: { dia: number; resumen: string }[] | null; recursos?: string[] | null
    indicadores?: string[] | null; producto_final?: string | null; evidencias?: string[] | null
  } | null
}
export type BaseAjuste = { planeacion: Planeacion; numero: number; contenido: string; estructura: EstructuraVersion; trazabilidad: unknown }

export async function baseVigente(sb: SupabaseClient, planeacion: Planeacion): Promise<BaseAjuste | null> {
  const { data } = await sb
    .from('planeacion_versiones')
    .select('numero, contenido, estructura, trazabilidad_curricular')
    .eq('planeacion_id', planeacion.id)
    .eq('numero', planeacion.version)
    .maybeSingle()
  const v = data as { numero: number; contenido: string | null; estructura: EstructuraVersion | null; trazabilidad_curricular: unknown } | null
  if (!v?.contenido) return null // sin texto canónico no hay base que ajustar (nunca se inventa)
  return { planeacion, numero: v.numero, contenido: v.contenido, estructura: v.estructura ?? {}, trazabilidad: v.trazabilidad_curricular }
}

// Base de una versión EXACTA (inmutable) de una planeación del docente y
// del grupo indicado: la versión de la que partió un ajuste.
export async function baseDeVersion(sb: SupabaseClient, planeacionId: string, grupoId: string, numero: number): Promise<BaseAjuste | null> {
  const { data } = await sb.from('planeaciones').select('id, nombre, version, grupo_id, fecha_inicio, fecha_fin').eq('id', planeacionId).eq('grupo_id', grupoId).maybeSingle()
  return data ? baseVigente(sb, { ...(data as Planeacion), version: numero }) : null
}

// Estructura (mismos campos que planeacion_versiones.estructura) a partir
// del resumen de un borrador: referencia de conservación al seguir
// corrigiendo un borrador de ajuste.
export function estructuraDesdeResumen(r: ResumenBorrador): EstructuraVersion {
  return {
    planeacion: { nombre: r.nombre, proposito: r.proposito, fecha_inicio: r.fechaInicio, fecha_fin: r.fechaFin },
    proyecto: {
      nombre: r.nombre, campos_formativos: r.camposFormativos, contenidos: r.contenidos, pda: r.pda, ejes_articuladores: r.ejesArticuladores,
      metodologia: r.metodologia, duracion_dias: r.duracionDias, actividades: r.secuenciaDidactica as { dia: number; resumen: string }[], recursos: r.recursos,
      indicadores: r.indicadores, producto_final: r.productoFinal, evidencias: r.evidencias,
    },
  }
}

// ------------------------------------------------------------------
// Secciones del texto
// ------------------------------------------------------------------
export type Seccion = { clave: string; titulo: string; texto: string }

function claveDeEncabezado(linea: string): { clave: string; titulo: string } | null {
  const l = linea.trim()
  if (l.startsWith('📋')) return { clave: 'encabezado', titulo: 'Encabezado' }
  if (l.startsWith('🎯')) return { clave: 'proposito', titulo: 'Propósito' }
  if (/^📌\s*CONTENIDOS Y PDA/i.test(l)) return { clave: 'curricular', titulo: 'Contenidos y PDA' }
  if (l.startsWith('🧰')) return { clave: 'materiales', titulo: 'Materiales' }
  const dia = l.match(/^📅\s*(?:D[ÍI]A|SESI[ÓO]N)\s*(\d+)/i)
  if (dia) return { clave: `dia:${dia[1]}`, titulo: `Día ${dia[1]}` }
  if (l.startsWith('🎓')) return { clave: 'producto', titulo: 'Producto final' }
  return null
}

// Cuerpo (antes del bloque de resumen) en secciones de primer nivel. null
// si no se reconoce una estructura de planeación (o hay claves repetidas).
export function seccionesDe(cuerpo: string): Seccion[] | null {
  const secciones: Seccion[] = []
  for (const linea of cuerpo.split('\n')) {
    const enc = claveDeEncabezado(linea)
    if (enc) secciones.push({ ...enc, texto: linea })
    else if (secciones.length > 0) secciones[secciones.length - 1].texto += `\n${linea}`
  }
  const claves = secciones.map((s) => s.clave)
  if (secciones.length < 2 || new Set(claves).size !== claves.length || claves[0] !== 'encabezado') return null
  return secciones.map((s) => ({ ...s, texto: s.texto.trimEnd() }))
}

const normal = (t: string) => t.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean).join('\n')

export function separarResumen(texto: string): { cuerpo: string; resumen: string | null } {
  const i = texto.indexOf(ETIQUETA_INICIO_BLOQUE)
  if (i === -1) return { cuerpo: texto.trim(), resumen: null }
  // El bloque termina en la primera línea en blanco seguida de texto que no es "Etiqueta: valor".
  const resto = texto.slice(i).split('\n')
  const lineas: string[] = []
  for (const l of resto) {
    if (lineas.length > 0 && l.trim() && !/^[^:\n]{2,40}:\s/.test(l.trim()) && !l.trim().startsWith(ETIQUETA_INICIO_BLOQUE)) break
    lineas.push(l)
  }
  return { cuerpo: texto.slice(0, i).trim(), resumen: lineas.join('\n').trim() }
}

// ------------------------------------------------------------------
// Qué pide la instrucción
// ------------------------------------------------------------------
const RANGO_DIACRITICOS = new RegExp('[̀-ͯ]', 'g')
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(RANGO_DIACRITICOS, '')

// Claves de sección (y campos del resumen) que la instrucción menciona.
// 'global' si cambia la estructura o no se puede acotar.
export function alcanceDeInstruccion(instruccion: string): Set<string> | 'global' {
  const n = norm(instruccion)
  if (/\b(fechas?|duracion|calendario|semanas?|mas dias|menos dias|mas sesiones|menos sesiones|todo|toda|todas|completa|completo|general|reescribe|rehaz|adapta|nivel|simplifica|resume|alarga|acorta)\b/.test(n)) return 'global'
  if (/\b(\d+)\s*(dias|sesiones|clases)\b/.test(n) && !/\b(dia|sesion|clase)\s*\d+\b/.test(n)) return 'global'
  const alcance = new Set<string>()
  for (const m of n.matchAll(/\b(?:dia|sesion|clase)\s*(\d+)\b/g)) alcance.add(`dia:${m[1]}`)
  const ORD: Record<string, number> = { primer: 1, primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercer: 3, tercero: 3, cuarta: 4, cuarto: 4, quinta: 5, quinto: 5 }
  for (const m of n.matchAll(/\b(primer|primera|primero|segunda|segundo|tercera|tercer|tercero|cuarta|cuarto|quinta|quinto)\s+(?:dia|sesion|clase)\b/g)) alcance.add(`dia:${ORD[m[1]]}`)
  if (/\bproposito\b/.test(n)) alcance.add('proposito')
  if (/\b(materiales?|recursos?)\b/.test(n)) alcance.add('materiales')
  if (/\bproducto\b/.test(n)) alcance.add('producto')
  if (/\b(contenidos?|pda|campos? formativos?|ejes?)\b/.test(n)) { alcance.add('curricular'); alcance.add('encabezado') }
  if (/\b(nombre|titulo|se llame|llamese|metodologia)\b/.test(n)) alcance.add('encabezado')
  if (/\b(evaluacion|evaluar|indicadores?|evidencias?|criterios?)\b/.test(n)) alcance.add('evaluacion')
  return alcance.size > 0 ? alcance : 'global'
}

// Categorías protegidas: lo curricular (contenidos, PDA, campos, ejes) y los
// indicadores de evaluación solo cambian si la instrucción los menciona,
// aunque el alcance sea global o no reconocido.
export function mencionaCurricular(instruccion: string): boolean {
  return /\b(contenidos?|pda|campos? formativos?|ejes?)\b/.test(norm(instruccion))
}
export function mencionaEvaluacion(instruccion: string): boolean {
  return /\b(evaluacion|evaluar|indicadores?|evidencias?|criterios?)\b/.test(norm(instruccion))
}
const ES_LINEA_EVALUACION = /^\s*📌\s*Evaluaci[oó]n\b/i
const CAMPOS_PROTEGIDOS = new Set(['Campos formativos', 'Contenidos', 'PDA', 'Ejes articuladores', 'Indicadores de evaluación'])

function afecta(alcance: Set<string> | 'global', clave: string): boolean {
  if (alcance === 'global') return true
  if (alcance.has(clave)) return true
  // La evaluación vive también dentro de cada día: no se restauran días.
  return alcance.has('evaluacion') && clave.startsWith('dia:')
}

// Campos del resumen ↔ alcance que los autoriza a cambiar.
const CAMPOS_RESUMEN: { etiqueta: string; alcance: string; valor: (e: EstructuraVersion) => string | null }[] = [
  { etiqueta: 'Nombre', alcance: 'encabezado', valor: (e) => e.planeacion?.nombre ?? null },
  { etiqueta: 'Propósito', alcance: 'proposito', valor: (e) => e.planeacion?.proposito ?? null },
  { etiqueta: 'Campos formativos', alcance: 'curricular', valor: (e) => lista(e.proyecto?.campos_formativos) },
  { etiqueta: 'Contenidos', alcance: 'curricular', valor: (e) => lista(e.proyecto?.contenidos) },
  { etiqueta: 'PDA', alcance: 'curricular', valor: (e) => lista(e.proyecto?.pda) },
  { etiqueta: 'Ejes articuladores', alcance: 'curricular', valor: (e) => lista(e.proyecto?.ejes_articuladores) },
  { etiqueta: 'Metodología', alcance: 'encabezado', valor: (e) => e.proyecto?.metodologia ?? null },
  { etiqueta: 'Recursos', alcance: 'materiales', valor: (e) => lista(e.proyecto?.recursos) },
  { etiqueta: 'Producto final', alcance: 'producto', valor: (e) => e.proyecto?.producto_final ?? null },
  { etiqueta: 'Evidencias', alcance: 'evaluacion', valor: (e) => lista(e.proyecto?.evidencias) },
  { etiqueta: 'Indicadores de evaluación', alcance: 'evaluacion', valor: (e) => lista(e.proyecto?.indicadores) },
]
function lista(v: string[] | null | undefined): string | null {
  return Array.isArray(v) && v.length > 0 ? v.join('; ') : null
}
function leerCampo(bloque: string, etiqueta: string): string | null {
  return bloque.match(new RegExp(`^${etiqueta}:\\s*(.*)$`, 'mi'))?.[1]?.trim() ?? null
}
function fijarCampo(bloque: string, etiqueta: string, valor: string): string {
  const re = new RegExp(`^${etiqueta}:.*$`, 'mi')
  return re.test(bloque) ? bloque.replace(re, `${etiqueta}: ${valor}`) : bloque
}

// ------------------------------------------------------------------
// Borrador ajustado
// ------------------------------------------------------------------
export { ETIQUETA_AJUSTE }

export type AjusteCalculado = {
  textoFinal: string
  cambios: string[]
  // true si se pudo comparar sección por sección (cuerpo y resumen).
  verificado: boolean
  restauradas: string[]
}

// referencia: de dónde se restaura lo no pedido. Por omisión la versión
// base; al seguir corrigiendo un borrador de ajuste, el último borrador
// confiable (conserva los cambios ya pedidos). El resumen de cambios se
// calcula SIEMPRE contra la versión base.
export type ReferenciaAjuste = { contenido: string; estructura: EstructuraVersion }

export function construirBorradorAjustado(entrada: { textoModelo: string; base: BaseAjuste; instruccion: string; avisoBase?: string | null; referencia?: ReferenciaAjuste; formato?: FormatoAjuste | null }): AjusteCalculado | null {
  const { base } = entrada
  const ref = entrada.referencia ?? base
  const modelo = separarResumen(entrada.textoModelo)
  if (!modelo.resumen) return null // sin bloque de resumen no es un borrador completo
  const alcance = alcanceDeInstruccion(entrada.instruccion)
  const secBase = seccionesDe(separarResumen(base.contenido).cuerpo)
  const secRef = entrada.referencia ? seccionesDe(separarResumen(ref.contenido).cuerpo.slice(Math.max(0, separarResumen(ref.contenido).cuerpo.indexOf('📋')))) : secBase
  let secModelo = seccionesDe(modelo.cuerpo.slice(Math.max(0, modelo.cuerpo.indexOf('📋'))))
  const restauradas: string[] = []

  // 1) Cuerpo: restaurar secciones no pedidas (misma estructura, alcance acotado).
  if (secRef && secModelo) {
    // La sección curricular la escribe el servidor: si no se pidió cambiarla,
    // se usa la de la base (aunque el modelo la haya omitido).
    const curricularBase = secRef.find((s) => s.clave === 'curricular')
    if (curricularBase && !mencionaCurricular(entrada.instruccion)) {
      const sinCurricular = secModelo.filter((s) => s.clave !== 'curricular')
      const iProposito = sinCurricular.findIndex((s) => s.clave === 'proposito')
      sinCurricular.splice(iProposito >= 0 ? iProposito + 1 : 1, 0, curricularBase)
      if (!secModelo.some((s) => s.clave === 'curricular' && normal(s.texto) === normal(curricularBase.texto))) restauradas.push(curricularBase.titulo)
      secModelo = sinCurricular
    }
    const mismaEstructura = secRef.map((s) => s.clave).join('|') === secModelo.map((s) => s.clave).join('|')
    if (mismaEstructura && alcance !== 'global') {
      secModelo = secModelo.map((s, i) => {
        if (afecta(alcance, s.clave) || normal(s.texto) === normal(secRef[i].texto)) return s
        if (!restauradas.includes(s.titulo)) restauradas.push(s.titulo)
        return secRef[i]
      })
    }
  }
  // Líneas de evaluación de cada día: si la instrucción no habla de
  // evaluación, son las de la base (aunque el día cambie por otra razón).
  if (secRef && secModelo && !mencionaEvaluacion(entrada.instruccion)) {
    secModelo = secModelo.map((s) => {
      const b = s.clave.startsWith('dia:') ? secRef.find((x) => x.clave === s.clave) : undefined
      if (!b) return s
      const evalBase = b.texto.split('\n').filter((l) => ES_LINEA_EVALUACION.test(l))
      const lineas = s.texto.split('\n')
      const evalModelo = lineas.filter((l) => ES_LINEA_EVALUACION.test(l))
      if (evalBase.length === 0 || normal(evalBase.join('\n')) === normal(evalModelo.join('\n'))) return s
      let k = 0
      const texto = evalModelo.length === evalBase.length
        ? lineas.map((l) => (ES_LINEA_EVALUACION.test(l) ? evalBase[k++] : l)).join('\n')
        : [...lineas.filter((l) => !ES_LINEA_EVALUACION.test(l)), ...evalBase].join('\n')
      restauradas.push(`Evaluación (${s.titulo})`)
      return { ...s, texto }
    })
  }
  const cuerpoFinal = secModelo ? secModelo.map((s) => s.texto).join('\n\n') : modelo.cuerpo

  // 2) Resumen: campos no pedidos, desde la estructura de la base.
  let resumen = modelo.resumen
  const curricularPedido = mencionaCurricular(entrada.instruccion)
  const evaluacionPedida = mencionaEvaluacion(entrada.instruccion)
  {
    for (const c of CAMPOS_RESUMEN) {
      const valorBase = c.valor(ref.estructura)
      if (valorBase === null) continue
      // Con alcance global solo se protegen lo curricular y los indicadores
      // (salvo que se mencionen); con alcance acotado, todo lo no pedido.
      const protegido = CAMPOS_PROTEGIDOS.has(c.etiqueta) && !(c.alcance === 'curricular' ? curricularPedido : evaluacionPedida)
      if (alcance === 'global' ? !protegido : (alcance.has(c.alcance) || (c.alcance === 'encabezado' && alcance.has('curricular') && c.etiqueta !== 'Nombre'))) continue
      const actual = leerCampo(resumen, c.etiqueta)
      if (actual !== null && normal(actual) !== normal(valorBase)) {
        resumen = fijarCampo(resumen, c.etiqueta, valorBase)
        if (!restauradas.includes(c.etiqueta)) restauradas.push(c.etiqueta)
      }
    }
  }
  // Respaldo textual de la identidad del ajuste (la metadata del servidor es la principal).
  resumen = resumen.replace(new RegExp(`^${ETIQUETA_AJUSTE}:.*\\n?`, 'mi'), '').trimEnd()
  resumen = `${resumen}\n${ETIQUETA_AJUSTE}: «${base.planeacion.nombre}», versión ${base.numero}`

  // 3) Cambios reales respecto a la base (después de restaurar).
  const secFinal = seccionesDe(cuerpoFinal)
  const cambios: string[] = []
  let verificado = !!(secBase && secFinal)
  if (secBase && secFinal) {
    for (const s of secFinal) {
      const b = secBase.find((x) => x.clave === s.clave)
      if (!b) cambios.push(`${s.titulo} (nueva)`)
      else if (normal(b.texto) !== normal(s.texto)) cambios.push(s.titulo)
    }
    for (const b of secBase) if (!secFinal.some((s) => s.clave === b.clave)) cambios.push(`${b.titulo} (se quitó)`)
  }
  for (const c of CAMPOS_RESUMEN) {
    const valorBase = c.valor(base.estructura)
    const actual = leerCampo(resumen, c.etiqueta)
    if (valorBase === null || actual === null) { if (c.alcance === 'evaluacion') verificado = verificado && valorBase === null; continue }
    if (normal(valorBase) !== normal(actual) && !cambios.includes(c.etiqueta)) cambios.push(c.etiqueta)
  }

  const siguiente = base.numero + 1
  const aviso = entrada.avisoBase ? `${entrada.avisoBase}\n` : ''
  const notaFormato = entrada.formato ? ` Tomé nota de que lo quieres en ${entrada.formato === 'word' ? 'Word' : 'PDF'}: primero revisa el ajuste y apruébalo.` : ''
  const cierre = cambios.length === 0
    ? `${aviso}No encontré diferencias con la versión ${base.numero}: el ajuste no cambió nada. ¿Quieres intentarlo con otra indicación?`
    : `${aviso}Cambios respecto a la versión ${base.numero}: ${cambios.join(', ')}.${verificado ? ` Verifiqué que el resto es idéntico a la versión ${base.numero}.` : ''}${notaFormato} ¿Quieres corregir algo más? Si está bien, dime «apruébala» y la guardo como versión ${siguiente}.`
  return { textoFinal: `${cuerpoFinal}\n\n${resumen}\n\n${cierre}`, cambios, verificado, restauradas }
}

// ------------------------------------------------------------------
// Contexto de la única llamada de IA
// ------------------------------------------------------------------
// enCurso: seguir corrigiendo un borrador de ajuste; el texto de partida es
// ese borrador (último confiable), no la versión guardada.
export function contextoParaAjuste(base: BaseAjuste, instruccion: string, enCurso?: ReferenciaAjuste): string {
  if (enCurso) {
    const texto = contextoParaAjuste({ ...base, contenido: enCurso.contenido, estructura: enCurso.estructura }, instruccion)
    return texto.replace(`PLANEACIÓN VIGENTE (versión ${base.numero}):`, `BORRADOR DE AJUSTE EN CURSO (sobre la versión ${base.numero}; conserva sus cambios):`)
  }
  const e = base.estructura
  const resumenBase = [
    `${ETIQUETA_INICIO_BLOQUE}`,
    `Nombre: ${e.planeacion?.nombre ?? base.planeacion.nombre}`,
    `Fecha de inicio: ${e.planeacion?.fecha_inicio ?? base.planeacion.fecha_inicio ?? ''}`,
    `Fecha de fin: ${e.planeacion?.fecha_fin ?? base.planeacion.fecha_fin ?? ''}`,
    e.proyecto?.duracion_dias ? `Duración: ${e.proyecto.duracion_dias} días` : null,
    ...CAMPOS_RESUMEN.filter((c) => c.etiqueta !== 'Nombre').map((c) => { const v = c.valor(e); return v ? `${c.etiqueta}: ${v}` : null }),
    lista(e.proyecto?.actividades?.map((a) => `Día ${a.dia}: ${a.resumen}`)) ? `Secuencia didáctica: ${lista(e.proyecto?.actividades?.map((a) => `Día ${a.dia}: ${a.resumen}`))}` : null,
  ].filter(Boolean).join('\n')
  return `AJUSTE DE UNA PLANEACIÓN YA GUARDADA (versión ${base.numero} de «${base.planeacion.nombre}»).
Aplica SOLO lo que pide el docente: «${instruccion}».
- Devuelve la planeación COMPLETA, con el mismo formato y los mismos encabezados de sección, y al final su bloque "${ETIQUETA_INICIO_BLOQUE}" completo.
- Copia LITERALMENTE todo lo que la instrucción no pide cambiar (secciones, días, materiales, evaluación, contenidos, PDA e indicadores).
- No cambies contenidos, PDA, campos formativos ni indicadores salvo que la instrucción lo pida.
- No agregues explicaciones antes ni después de la planeación.

PLANEACIÓN VIGENTE (versión ${base.numero}):
${separarResumen(base.contenido).cuerpo}

${resumenBase}`
}

// ------------------------------------------------------------------
// Identidad del ajuste (metadata del servidor)
// ------------------------------------------------------------------
// formatoSolicitado: el archivo que el docente pidió junto con el cambio
// ("…y dámela en Word"); se conserva para entregarlo sobre la versión
// aprobada sin que tenga que repetirlo.
export type FormatoAjuste = 'word' | 'pdf'
// publicadoComo: número de la versión con que se publicó este borrador. Un
// borrador publicado conserva su identidad (para recuperar la aprobación
// sin duplicados), pero ya no es un ajuste pendiente: no se continúa ni se
// vuelve a publicar.
// turnoId/mensajeId: el turno del chat que generó el borrador y su mensaje
// (los escribe completar_turno_chat, en la misma transacción).
export type AjusteRegistrado = { planeacionId: string; versionBase: number; grupoId: string; huella: string; creadoEn: string; formatoSolicitado?: FormatoAjuste | null; publicadoComo?: number | null; turnoId?: string; mensajeId?: string | null }
export const MAXIMO_AJUSTES_REGISTRADOS = 20

// Huella del DOCUMENTO del borrador: hasta su línea de ajuste (el mensaje
// de cierre que sigue no cuenta), para reconocerlo igual en el historial
// que en el documento activo que el cliente reenvía al editarlo.
export function huellaBorrador(texto: string): string {
  const t = texto.replace(/\r\n/g, '\n')
  const linea = t.match(new RegExp(`^${ETIQUETA_AJUSTE}:.*$`, 'mi'))
  const documento = linea?.index !== undefined ? t.slice(0, linea.index + linea[0].length) : t
  return createHash('sha256').update(normal(documento), 'utf8').digest('hex')
}

export function ajustesDe(referencia: unknown): AjusteRegistrado[] {
  const a = (referencia as { ajustes?: unknown } | null)?.ajustes
  return Array.isArray(a) ? a.filter((x): x is AjusteRegistrado => !!x && typeof (x as AjusteRegistrado).huella === 'string' && typeof (x as AjusteRegistrado).planeacionId === 'string' && typeof (x as AjusteRegistrado).versionBase === 'number') : []
}

// Registra el borrador ajustado en la referencia de la conversación
// (conserva el resto del objeto). Dentro de un turno duradero del chat se
// difiere: completar_turno_chat lo escribe junto con el turno y su mensaje
// (atómico; si el turno no se completa, el borrador no queda aprobable).
// Fuera de un turno, mejor esfuerzo: la línea del resumen sigue
// protegiendo el borrador si esto falla.
export async function registrarAjuste(sb: SupabaseClient, conversacionId: string | null, ajuste: Omit<AjusteRegistrado, 'creadoEn' | 'publicadoComo' | 'turnoId' | 'mensajeId'>): Promise<void> {
  if (!conversacionId) return
  if (diferirAjusteAlTurno(conversacionId, { planeacionId: ajuste.planeacionId, versionBase: ajuste.versionBase, grupoId: ajuste.grupoId, huella: ajuste.huella, formatoSolicitado: ajuste.formatoSolicitado ?? null })) return
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const actual = ((data as { planeacion_activa?: Record<string, unknown> | null } | null)?.planeacion_activa ?? {}) as Record<string, unknown>
  const ajustes = [...ajustesDe(actual).filter((a) => a.huella !== ajuste.huella), { ...ajuste, creadoEn: new Date().toISOString() }].slice(-MAXIMO_AJUSTES_REGISTRADOS)
  const { error } = await sb.from('conversaciones_chat').update({ planeacion_activa: { ...actual, ajustes } }).eq('id', conversacionId)
  if (error) console.error('[PLANEACION_AJUSTE] no se pudo registrar el ajuste en la conversación:', error.message)
}

// Marca el borrador como publicado (versión numero): deja de ser un ajuste
// pendiente y conserva su identidad. Mejor esfuerzo: si falla, el ciclo de
// vida lo sigue reconociendo por la clave de la versión publicada.
export async function marcarAjustePublicado(sb: SupabaseClient, conversacionId: string | null, huella: string, numero: number): Promise<void> {
  if (!conversacionId) return
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const actual = ((data as { planeacion_activa?: Record<string, unknown> | null } | null)?.planeacion_activa ?? {}) as Record<string, unknown>
  const ajustes = ajustesDe(actual)
  if (!ajustes.some((a) => a.huella === huella && a.publicadoComo !== numero)) return
  const { error } = await sb.from('conversaciones_chat').update({ planeacion_activa: { ...actual, ajustes: ajustes.map((a) => (a.huella === huella ? { ...a, publicadoComo: numero } : a)) } }).eq('id', conversacionId)
  if (error) console.error('[PLANEACION_AJUSTE] no se pudo marcar el ajuste como publicado:', error.message)
}

// ¿Este borrador es un ajuste de una planeación guardada? Por la metadata
// del servidor (huella) o, como respaldo, por su línea del resumen.
export function ajusteDelBorrador(contenido: string, referencia: unknown): AjusteRegistrado | { planeacionId: null; versionBase: null } | null {
  const huella = huellaBorrador(contenido)
  const registrado = ajustesDe(referencia).find((a) => a.huella === huella)
  if (registrado) return registrado
  return new RegExp(`^${ETIQUETA_AJUSTE}:`, 'mi').test(contenido) ? { planeacionId: null, versionBase: null } : null
}

// Un borrador hecho a partir de otro borrador de ajuste (seguir
// corrigiéndolo) hereda su identidad: misma línea de resumen.
export function heredarAjuste(textoNuevo: string, textoPrevio: string): string | null {
  const linea = textoPrevio.match(new RegExp(`^${ETIQUETA_AJUSTE}:.*$`, 'mi'))?.[0]
  if (!linea || !textoNuevo.includes(ETIQUETA_INICIO_BLOQUE)) return null
  const limpio = textoNuevo.replace(new RegExp(`^${ETIQUETA_AJUSTE}:.*\\n?`, 'mi'), '')
  const { cuerpo, resumen } = separarResumen(limpio)
  if (!resumen) return null
  const resto = limpio.slice(limpio.indexOf(resumen) + resumen.length)
  return `${cuerpo}\n\n${resumen.trimEnd()}\n${linea}${resto}`
}

// Seguir corrigiendo un borrador de ajuste (desde el historial o desde el
// documento activo). SOLO si el previo tiene metadata registrada (huella):
// se aplican las mismas garantías de conservación que en el primer ajuste,
// con el último borrador confiable como referencia (no se pierden los
// cambios ya pedidos) y el resumen de cambios contra la versión base; el
// nuevo borrador hereda la identidad (planeación, versión base, grupo) con
// su huella. Sin metadata confiable no se registra nada: solo se copia la
// línea (bloquea aprobarlo como nuevo) y no será publicable.
export async function continuarAjuste(sb: SupabaseClient, conversacionId: string | null, textoPrevio: string, textoNuevo: string, instruccion = ''): Promise<string | null> {
  const soloLinea = heredarAjuste(textoNuevo, textoPrevio)
  if (!soloLinea || !conversacionId) return soloLinea
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const origen = ajustePublicable(textoPrevio, (data as { planeacion_activa?: unknown } | null)?.planeacion_activa ?? null)
  if (!origen) {
    console.warn('[PLANEACION_AJUSTE] borrador de ajuste sin metadata registrada: no será publicable')
    return soloLinea
  }
  // Solo un ajuste PENDIENTE sobre la versión vigente se sigue corrigiendo:
  // uno ya publicado o con la base obsoleta nunca hereda una identidad
  // publicable (/api/chat los atiende antes, con la versión canónica).
  const { data: vigente } = await sb.from('planeaciones').select('version').eq('id', origen.planeacionId).maybeSingle()
  if (origen.publicadoComo || (vigente as { version?: number } | null)?.version !== origen.versionBase) {
    console.warn('[PLANEACION_AJUSTE] el borrador previo ya no es un ajuste pendiente de la versión vigente: no será publicable')
    return soloLinea
  }
  const base = await baseDeVersion(sb, origen.planeacionId, origen.grupoId, origen.versionBase)
  const resumenPrevio = extraerResumenBorrador([{ role: 'assistant', content: textoPrevio }])
  const ajustado = base && resumenPrevio
    ? construirBorradorAjustado({ textoModelo: textoNuevo, base, instruccion, referencia: { contenido: textoPrevio, estructura: estructuraDesdeResumen(resumenPrevio) } })
    : null
  if (!ajustado) {
    console.warn('[PLANEACION_AJUSTE] no se pudo verificar la conservación del borrador: no será publicable')
    return soloLinea
  }
  await registrarAjuste(sb, conversacionId, { planeacionId: origen.planeacionId, versionBase: origen.versionBase, grupoId: origen.grupoId, huella: huellaBorrador(ajustado.textoFinal), formatoSolicitado: origen.formatoSolicitado ?? null })
  return ajustado.textoFinal
}

// Petición de archivo dentro de una solicitud compuesta ("…y dámela en
// Word", "…y pásala a PDF"): se separa de la instrucción del cambio.
const PETICION_FORMATO = /[\s,;]*(?:\b(?:y|e)\s+)?(?:\b(?:d[aá]mela|d[aá]melo|p[aá]sala|p[aá]salo|gu[aá]rdala|gu[aá]rdalo|entr[eé]gamela|m[aá]ndamela|convi[eé]rtela|d[eé]jala|exp[oó]rtala|desc[aá]rgala|ponla|la\s+quiero|lo\s+quiero)\s+)?\b(?:en|a|como)\s+(?:un\s+)?(?:(?:archivo|documento|formato)\s+(?:de\s+)?)?(word|pdf)\b[.!]?/gi
export function formatoPedido(texto: string): FormatoAjuste | null {
  const m = [...texto.matchAll(PETICION_FORMATO)].pop()
  return m ? (m[1].toLowerCase() as FormatoAjuste) : null
}
export function sinPeticionDeFormato(texto: string): string {
  return texto.replace(PETICION_FORMATO, '').replace(/\s+([.,;])/g, '$1').trim()
}
// Solo pide el archivo ("pásala a Word"), sin ningún cambio.
export function soloPideFormato(texto: string): boolean {
  return formatoPedido(texto) !== null && /^(por favor|porfa|ok|ahora|tambien|ya)?[\s.,!]*$/i.test(norm(sinPeticionDeFormato(texto)))
}

// Anota el formato pedido sobre un borrador de ajuste ya registrado.
export async function anotarFormatoDelAjuste(sb: SupabaseClient, conversacionId: string | null, huella: string, formato: FormatoAjuste): Promise<void> {
  if (!conversacionId) return
  const { data } = await sb.from('conversaciones_chat').select('planeacion_activa').eq('id', conversacionId).maybeSingle()
  const actual = ((data as { planeacion_activa?: Record<string, unknown> | null } | null)?.planeacion_activa ?? {}) as Record<string, unknown>
  const ajustes = ajustesDe(actual).map((a) => (a.huella === huella ? { ...a, formatoSolicitado: formato } : a))
  const { error } = await sb.from('conversaciones_chat').update({ planeacion_activa: { ...actual, ajustes } }).eq('id', conversacionId)
  if (error) console.error('[PLANEACION_AJUSTE] no se pudo anotar el formato pedido:', error.message)
}

// Identidad CONFIABLE del borrador (etapa 3b): solo la metadata del
// servidor (huella registrada). La línea del resumen nunca basta: sin
// metadata, no se publica (falla de forma segura). Devuelve también un
// borrador ya publicado (publicadoComo): su estado lo decide
// cicloDelAjuste (aprobarAjuste.ts) contra la versión canónica.
export function ajustePublicable(contenido: string, referencia: unknown): AjusteRegistrado | null {
  const huella = huellaBorrador(contenido)
  return ajustesDe(referencia).find((a) => a.huella === huella) ?? null
}

export const MENSAJE_AJUSTE_SIN_APROBACION = 'Este borrador es un ajuste de una planeación ya guardada, así que no lo guardaré como una planeación distinta. Pídeme que lo prepare de nuevo sobre la planeación y luego apruébalo.'
