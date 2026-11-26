// Hito 2, etapa 5a — pestaña Planeación (biblioteca de solo lectura).
// Sin red, sin IA: cliente de Supabase falso con RLS por docente y
// render estático de los componentes reales.
//   npx tsx scripts/verificar-vista-planeacion.tsx

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  agruparPorMes,
  campoFormativoDe,
  cargarDetallePlaneacion,
  cargarEstadosEvaluacion,
  cargarResumenPlaneaciones,
  rangoFechas,
  sesionesDe,
  textoSesiones,
  type ResumenPlaneacion,
} from '../lib/planeacion/vistaPlaneacion'
import * as documentoVersion from '../lib/planeacion/documentoVersion'
import * as archivosVersion from '../lib/planeacion/archivosVersion'
import { COLOR_ESTADO_HOJA, ETIQUETA_ESTADO_HOJA } from '../lib/seguimiento/etiquetasEstadoHoja'
import ContenidoVersion from '../components/Planeacion/ContenidoVersion'
import ListaPlaneaciones from '../components/Planeacion/ListaPlaneaciones'
import { analizarContenido } from '../lib/documentGen/parseContenido'

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
const G1 = 'g1000000-0000-4000-8000-000000000001'
const G2 = 'g2000000-0000-4000-8000-000000000002'
const CONTENIDO = '📋 PLANEACIÓN DIDÁCTICA\nCampo Formativo: Lenguajes\n\n🎯 PROPÓSITO GENERAL\nQue escriban cuentos.\n\n📊 INDICADORES DE EVALUACIÓN\n1. Indicador viejo\n\n🧰 MATERIALES\n- Hojas blancas'

type Fila = Record<string, unknown>
function base() {
  const est = (campos: string[], dias: number, indicadores: string[]) => ({ proyecto: { campos_formativos: campos, duracion_dias: dias, actividades: Array.from({ length: dias }, (_, i) => ({ dia: i + 1 })), indicadores } })
  return {
    planeaciones: [
      { id: 'p1', docente_id: A, grupo_id: G1, nombre: '¡A contar historias!', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-30', estado: 'publicada', version: 4, creado_en: '2026-11-24T10:00:00Z' },
      { id: 'p2', docente_id: A, grupo_id: G1, nombre: 'Las Leyendas', fecha_inicio: '2026-12-01', fecha_fin: '2026-12-12', estado: 'publicada', version: 1, creado_en: '2026-11-25T10:00:00Z' },
      { id: 'p3', docente_id: A, grupo_id: G1, nombre: 'Borrador suelto', fecha_inicio: '2026-11-10', fecha_fin: null, estado: 'borrador', version: 1, creado_en: '2026-11-01T10:00:00Z' },
      { id: 'p4', docente_id: A, grupo_id: G2, nombre: 'De otro grupo', fecha_inicio: '2026-11-20', fecha_fin: null, estado: 'publicada', version: 1, creado_en: '2026-11-20T10:00:00Z' },
      { id: 'p5', docente_id: B, grupo_id: G1, nombre: 'De otro docente', fecha_inicio: '2026-11-21', fecha_fin: null, estado: 'publicada', version: 1, creado_en: '2026-11-21T10:00:00Z' },
    ] as Fila[],
    planeacion_versiones: [
      { id: 'v1', planeacion_id: 'p1', docente_id: A, grupo_id: G1, numero: 1, origen: 'aprobacion', contenido: CONTENIDO, estructura: est(['Lenguajes'], 5, ['Indicador original']), hoja_id: 'h1', documento_word_archivo_id: 'w1', documento_pdf_archivo_id: 'f1', creada_en: '2026-11-24T10:00:00Z' },
      { id: 'v2', planeacion_id: 'p1', docente_id: A, grupo_id: G1, numero: 2, origen: 'modificacion', contenido: CONTENIDO, estructura: est(['Lenguajes'], 5, ['Indicador v2']), hoja_id: 'h1', documento_word_archivo_id: 'w2', documento_pdf_archivo_id: null, creada_en: '2026-11-25T10:00:00Z' },
      { id: 'v4', planeacion_id: 'p1', docente_id: A, grupo_id: G1, numero: 4, origen: 'modificacion', contenido: CONTENIDO, estructura: est(['Lenguajes', 'Saberes y pensamiento científico'], 6, ['Indicador canónico v4']), hoja_id: 'h1', documento_word_archivo_id: null, documento_pdf_archivo_id: 'f4', creada_en: '2026-11-26T10:00:00Z' },
      { id: 'vp2', planeacion_id: 'p2', docente_id: A, grupo_id: G1, numero: 1, origen: 'aprobacion', contenido: CONTENIDO, estructura: est(['Lenguajes'], 10, []), hoja_id: null, documento_word_archivo_id: 'w9', documento_pdf_archivo_id: 'f9', creada_en: '2026-11-25T10:00:00Z' },
      { id: 'vp4', planeacion_id: 'p4', docente_id: A, grupo_id: G2, numero: 1, origen: 'aprobacion', contenido: 'otro grupo', estructura: est(['Ética'], 3, []), hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-20T10:00:00Z' },
      { id: 'vp5', planeacion_id: 'p5', docente_id: B, grupo_id: G1, numero: 1, origen: 'aprobacion', contenido: 'ajeno', estructura: est(['Ética'], 3, []), hoja_id: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-21T10:00:00Z' },
    ] as Fila[],
    hojas_evaluacion: [{ id: 'h1', docente_id: A, identificador_visible: 'SG-3UAA', proyecto_id: 'pr1', reemplazada_por: null, indicadores: [{ indicador_especifico: 'Indicador original' }] }] as Fila[],
  }
}
type Bd = ReturnType<typeof base>

// Cliente del docente con RLS (solo sus filas) que registra cada consulta.
function cliente(bd: Bd, docente: string) {
  const consultas: { tabla: string; columnas: string; filtros: string[]; escritura?: string }[] = []
  const from = (tabla: keyof Bd) => {
    const c = { tabla, columnas: '', filtros: [] as string[] }
    consultas.push(c)
    let filas = bd[tabla].filter((f) => f.docente_id === docente)
    let orden: [string, boolean] | null = null
    const proyectar = (f: Fila) => {
      // estructura->proyecto->x como alias (lo que hace PostgREST).
      const r: Fila = { ...f }
      for (const m of c.columnas.matchAll(/(\w+):estructura->proyecto->(\w+)/g)) r[m[1]] = ((f.estructura as Fila)?.proyecto as Fila)?.[m[2]] ?? null
      return r
    }
    const resultado = () => {
      let r = filas.map(proyectar)
      if (orden) r = [...r].sort((a, b) => ((a[orden![0]] as number) - (b[orden![0]] as number)) * (orden![1] ? 1 : -1))
      return r
    }
    const q = {
      select: (col: string) => { c.columnas = col; return q },
      eq: (col: string, v: unknown) => { c.filtros.push(`${col}=${v}`); filas = filas.filter((f) => f[col] === v); return q },
      in: (col: string, vs: unknown[]) => { c.filtros.push(`${col} in ${vs.length}`); filas = filas.filter((f) => vs.includes(f[col])); return q },
      order: (col: string, o: { ascending: boolean }) => { orden = [col, o.ascending]; return q },
      maybeSingle: async () => ({ data: resultado()[0] ?? null, error: null }),
      insert: () => { consultas.push({ ...c, escritura: 'insert' }); return q },
      update: () => { consultas.push({ ...c, escritura: 'update' }); return q },
      then: (r: (x: unknown) => unknown) => Promise.resolve({ data: resultado(), error: null }).then(r),
    }
    return q
  }
  return { sb: { from } as unknown as SupabaseClient, consultas }
}

async function main() {
  // El detalle incluye las acciones de documentos (5b), que cargan el cliente
  // de Supabase del navegador: variables ficticias, nunca un backend real.
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://127.0.0.1:9'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'sin-clave-pruebas'
  const { default: DetallePlaneacion } = await import('../components/Planeacion/DetallePlaneacion')
  console.log('== 1. Presentación')
  verificar(rangoFechas('2026-11-24', '2026-11-30') === '24 – 30 nov' && rangoFechas('2026-11-24', '2026-12-07') === '24 nov – 7 dic'
    && rangoFechas('2026-12-28', '2027-01-09') === '28 dic 2026 – 9 ene 2027' && rangoFechas('2026-11-24', null) === '24 nov' && rangoFechas(null, null) === null,
    '1a. Fechas legibles (mismo mes, meses distintos, años distintos, sin fin, sin fechas)')
  verificar(rangoFechas('2026-12-01', '2026-12-01') === '1 dic', '1b. Fechas de calendario sin desplazamiento por zona horaria')
  verificar(textoSesiones(5) === '5 sesiones' && textoSesiones(1) === '1 sesión' && textoSesiones(null) === null && textoSesiones(0) === null, '1c. Sesiones')
  verificar(campoFormativoDe({ proyecto: { campos_formativos: ['Lenguajes'] } }) === 'Lenguajes' && campoFormativoDe({ proyecto: { campos_formativos: ['Lenguajes', 'Ética'] } }) === 'Lenguajes +1' && campoFormativoDe(null) === null,
    '1d. Campo formativo de la estructura de la versión')
  verificar(sesionesDe({ proyecto: { duracion_dias: 5 } }) === 5 && sesionesDe({ proyecto: { actividades: [1, 2, 3] } }) === 3 && sesionesDe(null) === null, '1e. Sesiones: duración, o actividades si falta')
  const r = (id: string, inicio: string | null, creado = '2026-11-01T00:00:00Z'): ResumenPlaneacion => ({ id, nombre: id, fechaInicio: inicio, fechaFin: null, versionVigente: 1, campoFormativo: null, sesiones: null, hoja: null, creadoEn: creado })
  const meses = agruparPorMes([r('a', '2026-11-03'), r('b', '2026-12-01'), r('c', null), r('d', '2026-11-24'), r('e', '2025-09-10')])
  verificar(meses.map((m) => m.etiqueta).join('|') === 'Diciembre 2026|Noviembre 2026|Septiembre 2025|Sin fechas' && meses[1].planeaciones.map((p) => p.id).join() === 'd,a',
    '1f. Biblioteca por mes, de lo más reciente a lo más antiguo; sin fechas al final')
  const vista = leer('lib/planeacion/vistaPlaneacion.ts')
  verificar(!/new Date|Date\.now|fechaISOHoy|en curso|implementad|ejecuci[oó]n/i.test(vista.replace(/^\s*\/\/.*$/gm, '')), '1g. Nunca clasifica por la fecha de hoy (ni "en curso" ni "implementada")')

  console.log('== 2. Carga con RLS y aislamiento por grupo')
  {
    const bd = base()
    const { sb, consultas } = cliente(bd, A)
    const lista = await cargarResumenPlaneaciones(sb, G1)
    verificar(lista.map((p) => p.id).sort().join() === 'p1,p2', '2a. Solo las publicadas del grupo activo y del docente (sin borradores, sin otro grupo, sin otro docente)')
    const p1 = lista.find((p) => p.id === 'p1')!
    verificar(p1.versionVigente === 4 && p1.campoFormativo === 'Lenguajes +1' && p1.sesiones === 6 && p1.hoja?.codigo === 'SG-3UAA' && p1.hoja.proyectoId === 'pr1',
      '2b. Datos de la versión VIGENTE (no de la v1): campo, sesiones y hoja')
    const qv = consultas.find((c) => c.tabla === 'planeacion_versiones')!
    verificar(consultas[0].filtros.includes(`grupo_id=${G1}`) && consultas[0].filtros.includes('estado=publicada') && qv.filtros.includes(`grupo_id=${G1}`),
      '2c. Filtro explícito por grupo en planeaciones y versiones (además de la RLS)')
    verificar(!/contenido/.test(qv.columnas) && !/\bestructura\b(?!->)/.test(qv.columnas), '2d. La lista no descarga contenido ni la estructura completa (solo lo necesario)')
    verificar(consultas.every((c) => !c.escritura), '2e. Sin escrituras')
  }
  {
    const bd = base()
    const { sb } = cliente(bd, A)
    const d = await cargarDetallePlaneacion(sb, G1, 'p1')
    verificar(!!d && d.versiones.map((v) => v.numero).join() === '4,2,1' && d.versionVigente === 4, '2f. Detalle: todas las versiones, de la más reciente a la más antigua')
    verificar(d!.versiones[0].tieneWord === false && d!.versiones[0].tienePdf === true && d!.versiones[2].tieneWord && d!.versiones[2].tienePdf, '2g. Disponibilidad real de Word y PDF por versión')
    verificar(await cargarDetallePlaneacion(sb, G2, 'p1') === null && await cargarDetallePlaneacion(sb, G1, 'p4') === null && await cargarDetallePlaneacion(sb, G1, 'p5') === null && await cargarDetallePlaneacion(sb, G1, 'p3') === null,
      '2h. Detalle de otro grupo, de otro docente o sin publicar: no disponible')
  }
  {
    const pedidas: { url: string; auth: string }[] = []
    const falso = (async (url: string, init: { headers: Record<string, string> }) => {
      pedidas.push({ url, auth: init.headers.Authorization })
      if (url.includes('pr-falla')) return { ok: false, json: async () => ({}) }
      return { ok: true, json: async () => ({ estado: 'confirmado' }) }
    }) as unknown as typeof fetch
    const e = await cargarEstadosEvaluacion('tkn', ['pr1', 'pr1', 'pr-falla'], falso)
    verificar(e.pr1 === 'confirmado' && !('pr-falla' in e) && pedidas.length === 2 && pedidas.every((p) => p.auth === 'Bearer tkn' && p.url.endsWith('/estado-captura')),
      '2i. Estado real de la hoja con la misma ruta que Evaluación (una vez por proyecto; una falla no inventa estado)')
  }

  console.log('== 3. Contenido y detalle')
  {
    const html = renderToStaticMarkup(<ContenidoVersion contenido={CONTENIDO} numero={4} indicadores={['Indicador canónico v4']} />)
    verificar(!html.includes('PLANEACIÓN DIDÁCTICA') && !html.includes('Versión: 4'), '3a. Sin repetir el título del documento ni la versión (se muestran aparte)')
    verificar(html.includes('Indicador canónico v4') && !html.includes('Indicador viejo'), '3b. Indicadores canónicos de la versión (el mismo texto que el Word/PDF)')
    verificar(!/[📋🎯📊🧰]/u.test(html) && html.includes('PROPÓSITO GENERAL') && html.includes('Hojas blancas'), '3c. Secciones sin emojis, contenido íntegro')
    const CON_SESIONES = '📋 PLANEACIÓN\n\n📅 DÍA 1 — Entramos al mundo\nFecha estimada: martes 24 de noviembre de 2026\n🔷 Inicio (15 min)\nLa docente lee un cuento.\n🔶 Desarrollo — Actividad en equipos: "El juego de las cadenas" (30 min)\nCada equipo arma su cadena.\n- Tarjetas de colores\n🔻 Cierre (10 min)\nSe comparten dos escritos.\n📌 Evaluación: Participación oral.\n\n📅 DÍA 2 — Detectives\n🔷 Inicio (15 min)\nRepaso.\n🔶 Desarrollo\nTrabajo libre.\n\n🎓 PRODUCTO FINAL\nUn libro.'
    const sesiones = renderToStaticMarkup(<ContenidoVersion contenido={CON_SESIONES} numero={1} indicadores={[]} />)
    const s1 = sesiones.slice(sesiones.indexOf('<details'), sesiones.indexOf('</details>'))
    verificar(/aria-label="Día 1">1<\/span>/.test(s1) && s1.includes('>Entramos al mundo<') && /martes 24 de noviembre de 2026 · <span class="whitespace-nowrap">55 min<\/span>/.test(s1),
      '3c2. Sesión plegable: número, título, fecha y duración (suma de sus momentos)')
    verificar(/<ol class="relative[^"]*border-l border-green-200/.test(s1) && (s1.match(/rounded-full bg-green-600 ring-4/g) ?? []).length === 3 && />Inicio<span[^>]*>15 min<\/span>/.test(s1)
      && /Desarrollo — Actividad en equipos: (&quot;|")El juego de las cadenas(&quot;|")<span[^>]*>30 min<\/span>/.test(s1),
      '3c3. Inicio, Desarrollo y Cierre como línea vertical con nodos verdes')
    verificar(/bg-gray-50[^>]*><span[^>]*>Evaluación<\/span><span[^>]*>Participación oral\.<\/span>/.test(s1), '3c4. Evaluación diferenciada con fondo neutro')
    const s2 = sesiones.slice(sesiones.indexOf('<details', sesiones.indexOf('</details>')))
    verificar(s2.includes('>Detectives<') && !/\d+ min<\/span><\/span><svg/.test(s2.slice(0, s2.indexOf('</summary>'))) && !/[📅🔷🔶🔻📌🎓]/u.test(sesiones),
      '3c5. Sin minutos en todos sus momentos: no se calcula duración; sin emojis')
    // Integridad: cada línea canónica aparece completa y en el mismo orden.
    const texto = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ')
    const integro = (contenido: string) => {
      const plano = texto(renderToStaticMarkup(<ContenidoVersion contenido={contenido} numero={1} indicadores={[]} />))
      let desde = 0
      for (const l of analizarContenido(contenido).filter((x) => x.tipo !== 'titulo')) {
        const t = l.texto.replace(/^[\p{Extended_Pictographic}\u{1F300}-\u{1FAFF}\u{2190}-\u{2BFF}\uFE0F\s]+/u, '').trim()
          .replace(/^Fecha estimada:\s+/i, '').replace(/^Evaluaci[oó]n:\s+/i, '').replace(/^(.*?)\s*\((\d+) min\)$/, '$1 $2 min')
          .replace(/^D[IÍ]A\s+(\d+)\s*—\s*/i, '$1 ').replace(/\s+/g, ' ')
        const i = plano.indexOf(t, desde)
        if (i === -1) return t
        desde = i
      }
      return null
    }
    verificar(integro(CON_SESIONES) === null && integro(CONTENIDO) === null, '3c6. Contenido canónico íntegro y en orden (nada se resume, omite ni reordena)')
    const { default: TarjetaPlaneacion } = await import('../components/Planeacion/TarjetaPlaneacion')
    const tarjeta = renderToStaticMarkup(<TarjetaPlaneacion planeacion={{ id: 'x', nombre: 'Las Leyendas de Nuestra Comunidad', fechaInicio: '2026-11-24', fechaFin: '2026-12-07', versionVigente: 1, campoFormativo: 'Lenguajes', sesiones: 10, hoja: { id: 'h', codigo: 'SG-T6MU', proyectoId: 'pr', reemplazada: false }, creadoEn: '' }} estadoHoja="sin_fotografia" onAbrir={() => {}} />)
    verificar(tarjeta.includes('· Pendiente de resultados') && !/truncate/.test(tarjeta) && /flex flex-wrap items-center gap-x-3 gap-y-1\.5/.test(tarjeta), '3c7. Estado de evaluación completo en la tarjeta (puede pasar a otra línea, nunca se trunca)')
    verificar(/<main className="[^"]*pb-\[calc\(7rem\+env\(safe-area-inset-bottom\)\)\]/.test(leer('app/dashboard/planeacion/page.tsx')), '3c8. Espacio final para el botón flotante del Chat (112 px > 76 px que ocupa)')
    const bd = base()
    const { sb } = cliente(bd, A)
    const d = (await cargarDetallePlaneacion(sb, G1, 'p1'))!
    const historica = renderToStaticMarkup(<DetallePlaneacion detalle={d} version={d.versiones[1]} onSeleccionarVersion={() => {}} estadosHoja={{ pr1: 'confirmado' }} evaluacionDistinta="SG-3UAA" onArchivoGenerado={() => {}} />)
    verificar(historica.includes('Versión histórica · solo consulta. La vigente es la 4.') && historica.includes('Indicador v2') && !historica.includes('Indicador canónico v4'), '3d. Versión histórica: se consulta su propio contenido, marcada como histórica')
    verificar(historica.includes('href="/dashboard/evaluacion?proyecto=pr1"') && historica.includes('Resultados registrados') && historica.includes('SG-3UAA conserva sus criterios originales'),
      '3e. Hoja asociada con estado real, enlace al proyecto exacto y aviso de criterios originales')
    // 5b: además de elegir versión, solo hay acciones de documentos (Ver, Descargar, Generar).
    const etiquetas = [...historica.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]).filter((t) => !/^(Ver|Descargar|Generar (Word|PDF))$/.test(t))
    verificar(!/Aprobar|Guardar|Eliminar|Hacer vigente|Restaurar|Editar/i.test(historica) && [...historica.matchAll(/aria-current|<li><button/g)].length >= d.versiones.length && etiquetas.every((t) => t === ''),
      '3f. Consulta: elegir versión y acciones de documentos; nada se vuelve vigente ni se sobrescribe')
    const vigente = renderToStaticMarkup(<DetallePlaneacion detalle={d} version={d.versiones[0]} onSeleccionarVersion={() => {}} estadosHoja={{}} evaluacionDistinta={null} onArchivoGenerado={() => {}} />)
    verificar(vigente.includes('Versión 4 · vigente') && !vigente.includes('Versión histórica') && vigente.includes('Original guardado') && vigente.includes('Aún no generado') && vigente.includes('Lenguajes +1') && vigente.includes('6 sesiones'), '3g. Versión vigente: Word/PDF con disponibilidad real y datos de su estructura')
    const lista = renderToStaticMarkup(<ListaPlaneaciones planeaciones={await cargarResumenPlaneaciones(sb, G1)} estados={{ pr1: 'confirmado' }} onAbrir={() => {}} />)
    verificar(lista.indexOf('Diciembre 2026') < lista.indexOf('Noviembre 2026') && lista.includes('Versión 4') && lista.includes('SG-3UAA') && lista.includes('2 planeaciones'), '3h. Lista por mes con versión vigente y evaluación')
  }

  console.log('== 4. Fuentes, solo lectura y sin IA')
  const archivosCliente = ['app/dashboard/planeacion/page.tsx', 'lib/planeacion/vistaPlaneacion.ts', 'lib/planeacion/documentoVersion.ts', ...readdirSync(join(raiz, 'components/Planeacion')).map((f) => `components/Planeacion/${f}`)]
  // Solo código (sin comentarios).
  const codigo = archivosCliente.map(leer).join('\n').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  verificar(!/\.(insert|update|upsert|delete|rpc)\(|method:\s*'(POST|PATCH|DELETE)'/.test(codigo), '4a. Ninguna escritura (insert/update/delete/rpc/POST) en la pestaña')
  verificar(!/anthropic|motorTexto|generateText|streamText|openai|\/api\/chat|enviarMensaje/i.test(codigo), '4b. Cero IA: no importa motores ni llama al Chat')
  verificar(!/documentGen\/herramientas|archivosVersion|registroArchivos|SERVICE_ROLE|supabaseAdmin/.test(codigo), '4c. Sin módulos de servidor ni service role en el cliente')
  verificar(!/planeacion_proyectos/.test(leer('lib/planeacion/vistaPlaneacion.ts').replace(/^\s*\/\/.*$/gm, '')), '4d. Fuente canónica: versiones, nunca la proyección planeacion_proyectos')
  verificar(documentoVersion.textoDocumentoVersion === archivosVersion.textoDocumentoVersion && documentoVersion.notaSiEvaluacionDistinta === archivosVersion.notaSiEvaluacionDistinta,
    '4e. Pantalla y Word/PDF usan las mismas funciones (texto canónico y regla de evaluación)')

  console.log('== 5. Evaluación')
  verificar(ETIQUETA_ESTADO_HOJA.confirmado === 'Resultados registrados' && ETIQUETA_ESTADO_HOJA.sin_fotografia === 'Pendiente de resultados' && COLOR_ESTADO_HOJA.confirmado === 'text-green-600' && Object.keys(ETIQUETA_ESTADO_HOJA).length === 7,
    '5a. Etiquetas compartidas con los mismos valores que Evaluación tenía')
  const evaluacion = leer('app/dashboard/evaluacion/page.tsx')
  verificar(/const ETIQUETA_ESTADO = ETIQUETA_ESTADO_HOJA/.test(evaluacion) && /const COLOR_ESTADO = COLOR_ESTADO_HOJA/.test(evaluacion), '5b. Evaluación usa la misma fuente (sin cambio visible)')
  verificar(/get\('proyecto'\)/.test(evaluacion) && /proyectos\.some\(\(p\) => p\.id === id\)/.test(evaluacion) && /id=\{`proyecto-\$\{proyecto\.id\}`\}/.test(evaluacion),
    '5c. Enlace directo: solo resalta un proyecto que esté en la lista del grupo (nada se busca ni se abre por su cuenta)')

  console.log(`\n${total - fallos}/${total} pruebas pasaron.`)
  if (fallos) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
