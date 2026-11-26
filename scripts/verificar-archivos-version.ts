// Hito 2, etapa 4 — Word y PDF por versión de planeación.
// Sin red, sin IA: cliente de Supabase falso y reservas en memoria con la
// misma semántica que reservar/vincular/fallar (probadas en PostgreSQL en
// scripts/verificar-archivos-version-sql.sh).
//   npx tsx scripts/verificar-archivos-version.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ENCABEZADO_INDICADORES,
  archivoPedidoConAjuste,
  notaEvaluacionHistorica,
  obtenerArchivoDeVersion,
  respuestaArchivoVersion,
  sufijoNombreVersion,
  textoDocumentoVersion,
  type DependenciasArchivoVersion,
} from '../lib/planeacion/archivosVersion'
import { pedidoArchivoPlaneacion } from '../lib/planeacion/detectarConsultaPlaneacion'
import { configurarClienteRegistroArchivos, estadoEnlacesArchivo, registrarArchivo } from '../lib/documentGen/registroArchivos'

let fallos = 0
let total = 0
function verificar(ok: boolean, nombre: string) {
  total++
  if (!ok) fallos++
  console.log(`${ok ? '✓' : '✗'} ${nombre}`)
}
const raiz = join(__dirname, '..')
const leer = (r: string) => readFileSync(join(raiz, r), 'utf-8')

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CONTENIDO = '📋 PLANEACIÓN DIDÁCTICA — El dado de los cuentos\nCampo formativo: Lenguajes\n\nSesión 1\nInicio: ronda de cuentos.'
const INDICADORES_V4 = ['Narra un cuento con inicio, desarrollo y cierre.', 'Usa conectores temporales.']

type Fila = Record<string, unknown>
function base() {
  return {
    planeacion_versiones: [
      { id: 'v1', planeacion_id: 'p1', grupo_id: 'g1', docente_id: A, numero: 1, contenido: CONTENIDO, estructura: { proyecto: { indicadores: ['Indicador original'] } }, hoja_id: 'h1', documento_word_archivo_id: 'w-original', documento_pdf_archivo_id: 'f-original' },
      { id: 'v4', planeacion_id: 'p1', grupo_id: 'g1', docente_id: A, numero: 4, contenido: CONTENIDO, estructura: { proyecto: { indicadores: INDICADORES_V4 } }, hoja_id: 'h1', documento_word_archivo_id: null, documento_pdf_archivo_id: null },
      { id: 'vb', planeacion_id: 'pb', grupo_id: 'gb', docente_id: B, numero: 1, contenido: 'texto de B', estructura: {}, hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null },
    ] as Fila[],
    perfiles_docentes: [{ id: A, nombre: 'Docente A', grado: '6', grupo: 'C' }] as Fila[],
    grupos: [{ id: 'g1', docente_id: A, grado: '3', grupo: 'A' }, { id: 'gb', docente_id: B, grado: '1', grupo: 'B' }] as Fila[],
    hojas_evaluacion: [{ id: 'h1', docente_id: A, identificador_visible: 'SG-3UAA', proyecto_id: 'pr1', indicadores: [{ indicador_especifico: 'Indicador original' }] }] as Fila[],
    proyectos_seguimiento: [{ id: 'pr1', docente_id: A, estado: 'evaluado', captura_pendiente: null, confirmado_en: '2026-11-20T00:00:00Z' }] as Fila[],
    seguimiento_resultados: Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, docente_id: A, proyecto_id: 'pr1' })) as Fila[],
  }
}
type Bd = ReturnType<typeof base>

// Cliente del docente con RLS simulada (solo sus filas).
function clienteDocente(bd: Bd, docente: string): SupabaseClient {
  const from = (tabla: keyof Bd) => {
    const filtros: [string, unknown][] = []
    let cabeza = false
    const filas = () => bd[tabla].filter((f) => (f.docente_id ?? f.id) === docente || (tabla === 'perfiles_docentes' && f.id === docente)).filter((f) => filtros.every(([c, v]) => f[c] === v))
    const q = {
      select: (_c: string, o?: { head?: boolean }) => { cabeza = !!o?.head; return q },
      eq: (c: string, v: unknown) => { filtros.push([c, v]); return q },
      maybeSingle: async () => ({ data: filas()[0] ?? null, error: null }),
      single: async () => ({ data: filas()[0] ?? null, error: filas()[0] ? null : { message: 'no' } }),
      then: (r: (x: unknown) => unknown) => Promise.resolve(cabeza ? { count: filas().length, data: null, error: null } : { data: filas(), error: null }).then(r),
    }
    return q
  }
  return { from } as unknown as SupabaseClient
}

// Reservas en memoria con la semántica de la migración.
type Reserva = { estado: 'generando' | 'vinculado' | 'fallido'; ejecucion: string; reservadoEn: number; venceEn: number; archivo: string | null; intentos: number }
type Origen = { versionId: string; formato: string; ejecucionId: string } | null
type Registrado = { docente: string; nombre: string; mime: string; origen: Origen }
function servidor(bd: Bd, registro: Map<string, Registrado>, reloj = { ahora: 1000 }) {
  const reservas = new Map<string, Reserva>()
  const llamadas: string[] = []
  let n = 0
  const columna = (f: string) => (f === 'word' ? 'documento_word_archivo_id' : 'documento_pdf_archivo_id')
  const rpc = async (fn: string, a: Record<string, string>) => {
    llamadas.push(fn)
    const v = bd.planeacion_versiones.find((x) => x.id === a.p_version_id && x.docente_id === a.p_docente_id)
    const k = `${a.p_version_id}:${a.p_formato}`
    if (fn === 'reservar_archivo_version') {
      if (!v) return { data: { resultado: 'version_invalida' }, error: null }
      if (v[columna(a.p_formato)]) return { data: { resultado: 'existente', archivo_id: v[columna(a.p_formato)] }, error: null }
      const r = reservas.get(k)
      if (r && r.estado === 'generando' && r.venceEn > reloj.ahora) return { data: { resultado: 'en_proceso' }, error: null }
      const nueva: Reserva = { estado: 'generando', ejecucion: `e${++n}`, reservadoEn: reloj.ahora, venceEn: reloj.ahora + 150, archivo: null, intentos: (r?.intentos ?? 0) + 1 }
      reservas.set(k, nueva)
      return { data: { resultado: 'reservado', ejecucion_id: nueva.ejecucion }, error: null }
    }
    const r = reservas.get(k)
    if (fn === 'fallar_archivo_version') {
      if (r && r.estado === 'generando' && r.ejecucion === a.p_ejecucion_id) { r.estado = 'fallido'; return { data: { resultado: 'fallido' }, error: null } }
      return { data: { resultado: 'rechazado' }, error: null }
    }
    if (!r || r.estado !== 'generando' || r.ejecucion !== a.p_ejecucion_id || !v) return { data: { resultado: 'rechazado' }, error: null }
    if (r.venceEn <= reloj.ahora) { r.estado = 'fallido'; return { data: { resultado: 'vencido' }, error: null } }
    if (v[columna(a.p_formato)]) { r.estado = 'vinculado'; r.archivo = v[columna(a.p_formato)] as string; return { data: { resultado: 'existente', archivo_id: r.archivo }, error: null } }
    const f = registro.get(a.p_archivo_id)
    const mime = a.p_formato === 'word' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf'
    const ligado = bd.planeacion_versiones.some((x) => x.documento_word_archivo_id === a.p_archivo_id || x.documento_pdf_archivo_id === a.p_archivo_id)
    const procedencia = f?.origen?.versionId === a.p_version_id && f.origen.formato === a.p_formato && f.origen.ejecucionId === r.ejecucion
    if (!f || !procedencia || f.docente !== a.p_docente_id || f.mime !== mime || ligado) return { data: { resultado: 'archivo_invalido' }, error: null }
    v[columna(a.p_formato)] = a.p_archivo_id
    r.estado = 'vinculado'; r.archivo = a.p_archivo_id
    return { data: { resultado: 'vinculado', archivo_id: a.p_archivo_id }, error: null }
  }
  return { cliente: { rpc } as unknown as SupabaseClient, reservas, llamadas, reloj }
}

function escenario(opciones: { falla?: number; demora?: number; enlaces?: 'ok' | 'inexistente' | 'error'; alGenerar?: () => void } = {}) {
  const bd = base()
  const registro = new Map<string, Registrado>()
  const srv = servidor(bd, registro)
  const generados: { tipo: string; texto: string; perfil: Fila; userId: string; opciones: Record<string, unknown> }[] = []
  const descartados: string[] = []
  let fallasRestantes = opciones.falla ?? 0
  const deps: DependenciasArchivoVersion = {
    servidor: srv.cliente,
    generar: (async (tipo: string, texto: string, perfil: Fila, _z: unknown, _sb: unknown, userId: string, o: Record<string, unknown>) => {
      generados.push({ tipo, texto, perfil, userId, opciones: o })
      if (opciones.demora) await new Promise((r) => setTimeout(r, opciones.demora))
      opciones.alGenerar?.()
      if (fallasRestantes > 0) { fallasRestantes--; throw new Error('falla de subida simulada') }
      const id = `nuevo-${generados.length}`
      const nombre = `Planeacion_El_dado${tipo === 'word' ? '' : ''}_${o.sufijoNombre}.${tipo === 'word' ? 'docx' : 'pdf'}`
      registro.set(id, { docente: userId, nombre, mime: tipo === 'word' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf', origen: (o.origenVersion as Origen) ?? null })
      return { nombre, url: `https://firmada/${id}`, urlVer: `https://ver/${id}`, tamanoBytes: 1, archivoId: id }
    }) as unknown as DependenciasArchivoVersion['generar'],
    enlaces: async (_d, archivoId) => (opciones.enlaces ?? 'ok') === 'ok' ? { estado: 'ok', nombre: `original-${archivoId}`, url: `https://nueva/${archivoId}`, urlVer: `https://nueva-ver/${archivoId}` } : { estado: opciones.enlaces as 'inexistente' | 'error' },
    descartar: async (id) => { descartados.push(id) },
  }
  const pedir = (versionId: string, formato: 'word' | 'pdf' = 'pdf', docente = A) => obtenerArchivoDeVersion(deps, { sb: clienteDocente(bd, docente), docenteId: docente, versionId, formato, zonaHoraria: 'America/Hermosillo' })
  return { bd, srv, generados, descartados, pedir, registro, deps }
}

async function main() {
  console.log('== 1. Texto del documento (snapshot canónico de la versión)')
  const t = textoDocumentoVersion({ contenido: CONTENIDO, numero: 4, indicadores: INDICADORES_V4, notaEvaluacion: notaEvaluacionHistorica('SG-3UAA') })
  const l = t.split('\n')
  verificar(l[0] === CONTENIDO.split('\n')[0] && l[1] === 'Versión: 4', '1a. La versión se identifica discretamente bajo el título')
  verificar(t.includes(CONTENIDO.split('\n').slice(1).join('\n')), '1b. El contenido de la versión va íntegro, sin reescribir')
  verificar(t.includes(`${ENCABEZADO_INDICADORES}\n1. ${INDICADORES_V4[0]}\n2. ${INDICADORES_V4[1]}`), '1c. Incluye los indicadores canónicos de ESA versión, numerados')
  verificar(t.trimEnd().endsWith(notaEvaluacionHistorica('SG-3UAA')) && /conserva sus criterios originales/.test(t), '1d. Nota discreta y determinista de evaluación histórica al final')
  verificar(!textoDocumentoVersion({ contenido: CONTENIDO, numero: 2, indicadores: [] }).includes(ENCABEZADO_INDICADORES), '1e. Sin indicadores no se agrega la sección vacía')
  {
    const previo = `${CONTENIDO}\n\n${ENCABEZADO_INDICADORES}\n1. Indicador viejo A\n2. Indicador viejo B\n\n🎓 PRODUCTO FINAL\nUn libro de cuentos.`
    const r = textoDocumentoVersion({ contenido: previo, numero: 3, indicadores: INDICADORES_V4, notaEvaluacion: notaEvaluacionHistorica('SG-3UAA') })
    verificar(r.split(ENCABEZADO_INDICADORES).length === 2 && !r.includes('Indicador viejo') && r.includes(`${ENCABEZADO_INDICADORES}\n1. ${INDICADORES_V4[0]}\n2. ${INDICADORES_V4[1]}`),
      '1e2. Si el texto ya trae una sección de indicadores, se reemplaza por la canónica (sin duplicar ni conservar la vieja)')
    verificar(r.indexOf(ENCABEZADO_INDICADORES) < r.indexOf('🎓 PRODUCTO FINAL') && r.endsWith('🎓 PRODUCTO FINAL\nUn libro de cuentos.') && r.includes(notaEvaluacionHistorica('SG-3UAA')),
      '1e3. …en su lugar, sin tocar las secciones siguientes y con la nota junto a los indicadores')
    const minus = textoDocumentoVersion({ contenido: `${CONTENIDO}\n\nIndicadores de evaluación:\n- Viejo en minúsculas\n\nMATERIALES\n- Hojas`, numero: 3, indicadores: INDICADORES_V4 })
    verificar(!minus.includes('Viejo en minúsculas') && !/^Indicadores de evaluación:$/m.test(minus) && minus.includes('MATERIALES\n- Hojas') && minus.split(ENCABEZADO_INDICADORES).length === 2,
      '1e4. También reconoce un encabezado previo en otra capitalización ("Indicadores de evaluación:")')
    const sinEstructura = textoDocumentoVersion({ contenido: previo, numero: 2, indicadores: [] })
    verificar(sinEstructura.includes('Indicador viejo A') && sinEstructura.split(ENCABEZADO_INDICADORES).length === 2, '1e5. Sin indicadores en la estructura: el texto de la versión queda como está (nada inventado)')
    verificar(textoDocumentoVersion({ contenido: `${CONTENIDO}\n\nSESIÓN 2\nIndicadores observados durante la ronda.`, numero: 3, indicadores: INDICADORES_V4 }).includes('Indicadores observados durante la ronda.'),
      '1e6. Una línea de texto que menciona indicadores no se confunde con un encabezado')
  }
  verificar(sufijoNombreVersion(4) === 'version_4', '1f. Sufijo del nombre del archivo: version_4 (el mismo que valida la base: _version_4.ext)')
  const herramientas = leer('lib/documentGen/herramientas.ts')
  verificar(/if \(opciones\?\.sufijoNombre\) nombre = nombre\.replace\(\/\(\\\.\[a-z\]\+\)\$\/i, `_\$\{opciones\.sufijoNombre\}\$1`\)/.test(herramientas)
    && 'PLANEACION_EL_DADO.pdf'.replace(/(\.[a-z]+)$/i, '_version_4$1') === 'PLANEACION_EL_DADO_version_4.pdf', '1g. El generador de siempre agrega el sufijo antes de la extensión (sin otro cambio)')

  console.log('== 2. Recuperación del original (sin regenerar)')
  {
    const e = escenario()
    const r = await e.pedir('v1', 'word')
    verificar(r.tipo === 'archivo' && !r.generado && r.archivo.archivoId === 'w-original' && r.archivo.url === 'https://nueva/w-original', '2a. Versión 1: el Word original con enlaces firmados nuevos')
    verificar(e.generados.length === 0 && e.srv.llamadas.length === 0, '2b. Sin generar ni reservar')
    verificar(/^Aquí está el Word original de la versión 1\.\n\[\[DOCUMENTO_ARCHIVO:/.test(respuestaArchivoVersion(r)), '2c. Tarjeta de siempre (Ver, Descargar, Compartir) con el original')
    const ei = escenario({ enlaces: 'inexistente' })
    const ri = await ei.pedir('v1', 'pdf')
    verificar(ri.tipo === 'inexistente' && ei.generados.length === 0 && /ya no está disponible/.test(respuestaArchivoVersion(ri)) && /no lo reemplazo automáticamente/.test(respuestaArchivoVersion(ri)), '2d. Archivo realmente inexistente: se dice, sin regenerar ni sustituir la referencia')
    verificar(ei.bd.planeacion_versiones[0].documento_pdf_archivo_id === 'f-original', '2e. La referencia inmutable se conserva')
    const ee = escenario({ enlaces: 'error' })
    const re = await ee.pedir('v1', 'pdf')
    verificar(re.tipo === 'error' && ee.generados.length === 0 && /pídemelo de nuevo/.test(respuestaArchivoVersion(re)), '2f. Error pasajero al firmar: distinto de inexistente, se puede reintentar')
  }

  console.log('== 3. Generación bajo demanda de una versión sin archivo')
  {
    const e = escenario()
    const r = await e.pedir('v4', 'pdf')
    const g = e.generados[0]
    verificar(r.tipo === 'archivo' && r.generado && e.generados.length === 1, '3a. Versión 4 sin PDF: se genera una sola vez')
    verificar(g.tipo === 'pdf' && g.texto.includes('Versión: 4') && g.texto.includes(INDICADORES_V4[1]) && !g.texto.includes('Indicador original'), '3b. Desde el snapshot de la versión 4 con SUS indicadores (no los de la v1 ni de la hoja)')
    verificar(g.texto.includes(notaEvaluacionHistorica('SG-3UAA')), '3c. Hoja SG-3UAA con resultados y criterios distintos: la nota va en el documento')
    verificar(g.perfil.grado === '3°' && g.perfil.grupo === 'A', '3d. Encabezado con el grupo de la planeación (3° A), no el del perfil')
    verificar(g.opciones.sufijoNombre === 'version_4' && (g.opciones.registro as Fila)?.clase === 'conservar', '3e. Nombre con la versión y archivo permanente (conservar)')
    const origen = g.opciones.origenVersion as Origen
    verificar(origen?.versionId === 'v4' && origen.formato === 'pdf' && origen.ejecucionId === e.srv.reservas.get('v4:pdf')?.ejecucion, '3e2. El registro inicial lleva la identidad exacta: versión, formato y ejecución de la reserva')
    verificar(e.bd.planeacion_versiones[1].documento_pdf_archivo_id === 'nuevo-1' && e.bd.planeacion_versiones[1].documento_word_archivo_id === null, '3f. Queda ligado solo el PDF de la versión 4')
    verificar((e.bd.hojas_evaluacion[0].indicadores as unknown[]).length === 1 && e.bd.seguimiento_resultados.length === 10 && e.bd.proyectos_seguimiento[0].estado === 'evaluado', '3g. Hoja, resultados y proyecto intactos')
    const r2 = await e.pedir('v4', 'pdf')
    verificar(r2.tipo === 'archivo' && !r2.generado && r2.archivo.archivoId === 'nuevo-1' && e.generados.length === 1, '3h. Pedirlo otra vez recupera el mismo original (idempotente)')
    verificar(/^Aquí está el PDF de la versión 4\./.test(respuestaArchivoVersion(r)) && /^Aquí está el PDF original de la versión 4\./.test(respuestaArchivoVersion(r2)), '3i. Mensajes: generado vs original')
  }
  {
    const e = escenario()
    e.bd.hojas_evaluacion[0].indicadores = INDICADORES_V4.map((x) => ({ indicador_especifico: x }))
    await e.pedir('v4', 'word')
    verificar(!e.generados[0].texto.includes('conserva sus criterios originales'), '3j. Criterios iguales a los de la hoja: sin nota')
    const e2 = escenario()
    e2.bd.proyectos_seguimiento[0] = { ...e2.bd.proyectos_seguimiento[0], estado: 'hoja_generada', confirmado_en: null }
    e2.bd.seguimiento_resultados.length = 0
    await e2.pedir('v4', 'word')
    verificar(!e2.generados[0].texto.includes('conserva sus criterios originales'), '3k. Hoja sin capturas ni resultados: sin nota')
  }

  console.log('== 4. Concurrencia y reintentos')
  {
    const e = escenario({ demora: 30 })
    const [x, y] = await Promise.all([e.pedir('v4', 'pdf'), e.pedir('v4', 'pdf')])
    verificar(e.generados.length === 1 && [x.tipo, y.tipo].sort().join(',') === 'archivo,en_proceso', '4a. Dos dispositivos a la vez: una sola generación; el otro recibe «preparando»')
    verificar(/Pídemelo de nuevo en unos segundos/.test(respuestaArchivoVersion(x.tipo === 'en_proceso' ? x : y)), '4b. Mensaje claro mientras se prepara')
    const z = await e.pedir('v4', 'pdf')
    verificar(z.tipo === 'archivo' && !z.generado && e.generados.length === 1, '4c. El reintento posterior recupera el mismo archivo')
    const [w, p] = await Promise.all([e.pedir('v4', 'word'), e.pedir('v4', 'pdf')])
    verificar(w.tipo === 'archivo' && w.generado && p.tipo === 'archivo' && !p.generado && e.generados.length === 2, '4d. Word y PDF son independientes')
  }
  {
    // Otra ejecución (vencida y relevada) ganó: el archivo propio no se entrega.
    const e = escenario()
    const original = e.srv.cliente.rpc.bind(e.srv.cliente)
    ;(e.srv.cliente as unknown as { rpc: unknown }).rpc = async (fn: string, a: Record<string, string>) => {
      if (fn === 'vincular_archivo_version') e.bd.planeacion_versiones[1].documento_pdf_archivo_id = 'del-otro'
      return original(fn, a)
    }
    const r = await e.pedir('v4', 'pdf')
    verificar(r.tipo === 'archivo' && r.archivo.archivoId === 'del-otro' && e.descartados.join() === 'nuevo-1', '4e. Si otro intento ya lo ligó: se entrega el ligado y el duplicado se descarta')
  }
  {
    const e = escenario({ falla: 1 })
    const r = await e.pedir('v4', 'pdf')
    verificar(r.tipo === 'error' && e.srv.reservas.get('v4:pdf')?.estado === 'fallido' && e.bd.planeacion_versiones[1].documento_pdf_archivo_id === null, '4f. Falla de generación: reserva fallida, la versión sigue publicada sin archivo')
    verificar(/La planeación sigue guardada/.test(respuestaArchivoVersion(r)), '4g. Mensaje claro, sin perder la versión')
    const r2 = await e.pedir('v4', 'pdf')
    verificar(r2.tipo === 'archivo' && r2.generado && e.srv.reservas.get('v4:pdf')?.intentos === 2, '4h. Se recupera después pidiéndolo, sin aprobar de nuevo')
  }
  {
    const e = escenario()
    e.srv.reservas.set('v4:pdf', { estado: 'generando', ejecucion: 'muerta', reservadoEn: 0, venceEn: 10, archivo: null, intentos: 1 })
    const r = await e.pedir('v4', 'pdf')
    verificar(r.tipo === 'archivo' && r.generado, '4i. Una generación cuya función murió vence y se releva')
  }

  {
    // La generación tarda más que el plazo: la ejecución vence antes de vincular.
    let primera = true
    const e: ReturnType<typeof escenario> = escenario({ alGenerar: () => { if (primera) { primera = false; e.srv.reloj.ahora += 1000 } } })
    const r = await e.pedir('v4', 'word')
    verificar(r.tipo === 'error' && e.descartados.join() === 'nuevo-1' && e.bd.planeacion_versiones[1].documento_word_archivo_id === null && e.srv.reservas.get('v4:word')?.estado === 'fallido',
      '4j. Ejecución vencida: su archivo se descarta, nunca se liga, y la reserva queda libre')
    const r2 = await e.pedir('v4', 'word')
    verificar(r2.tipo === 'archivo' && r2.generado && r2.archivo.archivoId === 'nuevo-2', '4k. …y el siguiente pedido lo genera con una ejecución nueva')
  }

  console.log('== 5. Aislamiento')
  {
    const e = escenario()
    const r = await e.pedir('vb', 'pdf', A)
    verificar(r.tipo === 'error' && e.generados.length === 0 && e.srv.llamadas.length === 0, '5a. Una versión de otro docente no se lee, no se reserva ni se genera')
    // Un archivo ajeno (otro docente) o de otra versión no se liga.
    const res = (await e.srv.cliente.rpc('reservar_archivo_version', { p_docente_id: A, p_version_id: 'v4', p_formato: 'pdf' })).data as { ejecucion_id: string }
    e.registro.set('ajeno', { docente: B, nombre: 'x_version_4.pdf', mime: 'application/pdf', origen: { versionId: 'v4', formato: 'pdf', ejecucionId: res.ejecucion_id } })
    const v = (await e.srv.cliente.rpc('vincular_archivo_version', { p_docente_id: A, p_version_id: 'v4', p_formato: 'pdf', p_ejecucion_id: res.ejecucion_id, p_archivo_id: 'ajeno' })).data as { resultado: string }
    verificar(v.resultado === 'archivo_invalido', '5b. (espejo de la base) Archivo de otro docente aunque declare la misma ejecución: archivo_invalido')
  }
  {
    const bd = base()
    const filas = [{ docente_id: A, bucket: 'documentos-generados-ia', ruta: `${A}/1-x.pdf`, nombre: 'x.pdf', estado: 'activo' }]
    const firmar = { modo: 'ok' as 'ok' | 'not_found' | 'caida' }
    const falso = {
      from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: filas[0] ?? null, error: null }) }; return q },
      storage: { from: () => ({ createSignedUrl: async () => firmar.modo === 'ok' ? { data: { signedUrl: 'https://firmada' }, error: null } : { data: null, error: { message: firmar.modo === 'not_found' ? 'Object not found' : 'fetch failed' } } }) },
    } as unknown as SupabaseClient
    void bd
    configurarClienteRegistroArchivos(falso)
    const ok = await estadoEnlacesArchivo(A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    firmar.modo = 'not_found'
    const nf = await estadoEnlacesArchivo(A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    firmar.modo = 'caida'
    const caida = await estadoEnlacesArchivo(A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    filas[0] = { ...filas[0], ruta: `${B}/1-x.pdf` }
    const ruta = await estadoEnlacesArchivo(A, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    configurarClienteRegistroArchivos(null)
    verificar(ok.estado === 'ok' && nf.estado === 'inexistente' && caida.estado === 'error' && ruta.estado === 'inexistente', '5c. Enlaces: ok / objeto inexistente / falla pasajera / ruta ajena se distinguen')
  }

  {
    // Registro inicial real (registroArchivos.registrarArchivo) con cliente falso.
    const insertados: Fila[] = []
    configurarClienteRegistroArchivos({ from: () => ({ insert: async (d: Fila) => { insertados.push(d); return { error: null } } }) } as unknown as SupabaseClient)
    const comun = { docenteId: A, ruta: `${A}/1-x.pdf`, nombre: 'x.pdf', tipoMime: 'application/pdf', tamanoBytes: 1, clase: 'conservar' as const, conversacionId: null }
    const ej = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    const ver = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    await registrarArchivo(comun)
    await registrarArchivo({ ...comun, origenVersion: { versionId: ver, formato: 'pdf', ejecucionId: ej } })
    const invalido = await registrarArchivo({ ...comun, origenVersion: { versionId: 'no-uuid', formato: 'pdf', ejecucionId: ej } }).then(() => false, () => true)
    configurarClienteRegistroArchivos(null)
    verificar(!('version_id' in insertados[0]) && !('version_formato' in insertados[0]) && !('version_ejecucion_id' in insertados[0]), '5d. Los demás generadores registran exactamente las mismas columnas que antes')
    verificar(insertados[1].version_id === ver && insertados[1].version_formato === 'pdf' && insertados[1].version_ejecucion_id === ej && insertados[1].clase === 'conservar', '5e. El archivo de una versión lleva su origen desde el registro inicial')
    verificar(invalido && insertados.length === 2, '5f. Un origen mal formado no se registra (ni se sube)')
    const herramientas = leer('lib/documentGen/herramientas.ts')
    verificar(/\.\.\.\(opciones\?\.origenVersion \? \{ origenVersion: opciones\.origenVersion \} : \{\}\),\n\s+\}\)\)\)/.test(herramientas), '5g. El generador pasa el origen al registro previo a la subida')
  }

  console.log('== 6. Entradas conversacionales')
  const casos: [string, string | null, unknown][] = [
    ['Dame en PDF la planeación de cuentos propios', 'cuentos propios', null],
    ['Quiero el Word de la versión 2 de la planeación El dado de los cuentos', 'el dado de los cuentos', 2],
    ['Prepárame en Word la planeación del dado', 'dado', null],
    ['Pásame el PDF de la versión anterior de la planeación', '', 'anterior'],
  ]
  verificar(casos.every(([t, n, v]) => { const p = pedidoArchivoPlaneacion(t); return p?.nombre === n && p.version === v }), '6a. Pedido directo: nombre y versión (vigente por omisión, o la pedida)')
  verificar(['Hazme una planeación de fracciones en PDF', 'Genera una planeación en Word sobre fracciones', 'Dame el Word de la planeación', 'Cambia la sesión 2 de la planeación de cuentos y dámela en PDF', 'Apruébala y dame el PDF de la planeación de cuentos'].every((t) => pedidoArchivoPlaneacion(t) === null),
    '6b. Crear, modificar, aprobar o un pedido sin referente siguen su camino de siempre')
  const ruta = leer('app/api/chat/route.ts')
  const iEntrada1 = ruta.indexOf('[PLANEACION_CONSULTA] ${formatoOriginal} de la versión')
  const iEntrada2 = ruta.indexOf('const pedido = pedidoArchivoPlaneacion(')
  const iPipeline = ruta.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado && !esEdicionDocumento && !formatoDelAjuste) {')
  const iModelo = ruta.indexOf('const sesion = (supabaseUser && userId)')
  verificar(iEntrada1 > 0 && iEntrada1 < iEntrada2 && iEntrada2 < iPipeline && iPipeline < iModelo, '6c. Entradas 1 (consultada) y 2 (pedido directo) antes del camino de archivos y del modelo: cero IA')
  verificar(/\$\{await archivoPedidoConAjuste\(aprobacionAjuste, \{ servidor: supabaseRAG, sb: supabaseUser, docenteId: userId/.test(ruta) && /versionId: r\.versionId,\n\s+formatoSolicitado: ajuste\.formatoSolicitado/.test(leer('lib/planeacion/aprobarAjuste.ts')), '6d. Entrada 3: el formato pedido con el ajuste se entrega al aprobar, de la versión publicada')
  verificar((ruta.match(/obtenerArchivoDeVersion\(dependenciasArchivoVersion\(supabaseRAG\)/g) ?? []).length === 2, '6e. Las tres entradas usan el mismo orquestador con la ejecución confiable (service_role)')
  {
    const e = escenario()
    const sin = await archivoPedidoConAjuste({ codigo: 'VERSION_PUBLICADA', numero: 4, versionId: 'v4', formatoSolicitado: null }, { servidor: e.srv.cliente, sb: clienteDocente(e.bd, A), docenteId: A, zonaHoraria: null })
    const conflicto = await archivoPedidoConAjuste({ codigo: 'AJUSTE_OBSOLETO', numero: 4, versionId: 'v4', formatoSolicitado: 'pdf' }, { servidor: e.srv.cliente, sb: clienteDocente(e.bd, A), docenteId: A, zonaHoraria: null })
    verificar(sin === '' && conflicto === '' && e.generados.length === 0, '6g. Sin formato pedido (o sin publicar): no se genera nada (solo bajo demanda)')
    const ef = escenario({ falla: 1 })
    const fallo = await archivoPedidoConAjuste({ codigo: 'VERSION_PUBLICADA', numero: 4, versionId: 'v4', formatoSolicitado: 'pdf' }, { servidor: ef.srv.cliente, sb: clienteDocente(ef.bd, A), docenteId: A, zonaHoraria: null }, ef.deps)
    const luego = await ef.pedir('v4', 'pdf')
    verificar(/La planeación sigue guardada/.test(fallo) && luego.tipo === 'archivo' && luego.generado && ef.generados.length === 2, '6h. Falla tras aprobar: la versión queda publicada y el PDF se obtiene después pidiéndolo (sin aprobar de nuevo ni IA)')
    const ok = await archivoPedidoConAjuste({ codigo: 'VERSION_YA_PUBLICADA', numero: 4, versionId: 'v4', formatoSolicitado: 'pdf' }, { servidor: ef.srv.cliente, sb: clienteDocente(ef.bd, A), docenteId: A, zonaHoraria: null }, ef.deps)
    verificar(/Aquí está el PDF original de la versión 4/.test(ok) && ef.generados.length === 2, '6i. Reintento de una aprobación ya publicada: recupera el mismo archivo')
  }
  const modulo = leer('lib/planeacion/archivosVersion.ts')
  verificar(!/anthropic|motorTexto|generateText|streamText|openai/i.test(modulo), '6f. El módulo no importa ningún motor de IA')

  console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
  if (fallos) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
