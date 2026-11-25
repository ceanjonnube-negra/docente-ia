// Hito 2, etapa 2 — consulta de planeaciones guardadas desde el Chat IA.
// Sin red, sin IA: cliente de Supabase falso con RLS simulada por docente.
//   npx tsx scripts/verificar-consulta-planeaciones.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  coincidenciasPorNombre,
  contieneContenidoConsultado,
  detectarConsultaPlaneacion,
  elegirVersion,
  pideModificar,
  rangoDeFechasEnTexto,
  respuestaArchivoOriginal,
  seleccionEnTexto,
  resolverModificacionGuardada,
  ultimaRespuestaEsPregunta,
  versionConsultada,
  type VersionPlaneacion,
} from '../lib/planeacion/consultaPlaneaciones'
import { clasificacionConsultaPlaneacion } from '../lib/clasificadorNivel0'
import { ejecutarHerramientaDeModulo } from '../lib/asistente/herramientasModulo'
import { configurarClienteRegistroArchivos } from '../lib/documentGen/registroArchivos'
import { MARCADOR_DOCUMENTO_RECUPERADO, documentoParaHistorial, extraerMarcadorRecuperado } from '../lib/asistente/documentos'
import type { SesionContexto } from '../lib/sesionContexto'

let fallos = 0
function verificar(condicion: boolean, nombre: string) {
  if (condicion) console.log(`✓ ${nombre}`)
  else { fallos++; console.log(`✗ ${nombre}`) }
}

type Fila = Record<string, unknown>
const A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const B = 'bbbbbbbb-0000-4000-8000-00000000000b'
const GA = '0a000000-0000-4000-8000-0000000000aa'
const GA2 = '0a000000-0000-4000-8000-0000000000a2'
const GB = '0b000000-0000-4000-8000-0000000000bb'
const CONV = 'ca000000-0000-4000-8000-0000000000ca'
const W1 = 'e1000000-0000-4000-8000-000000000001', P1 = 'f1000000-0000-4000-8000-000000000001', W3 = 'e3000000-0000-4000-8000-000000000003'

// --- Cliente falso: filtros eq/gt/order y RLS por docente ---
function crearCliente(usuario: string, tablas: Record<string, Fila[]>, escrituras: { tabla: string; cambios: Fila }[]) {
  const visible = (tabla: string, f: Fila) => {
    if (tabla === 'planeaciones' || tabla === 'planeacion_versiones' || tabla === 'conversaciones_chat') return f.docente_id === usuario
    return true
  }
  const from = (tabla: string) => {
    const filtros: ((f: Fila) => boolean)[] = []
    let orden: { col: string; asc: boolean } | null = null
    let cambios: Fila | null = null
    const filas = () => {
      const r = (tablas[tabla] ?? []).filter((f) => visible(tabla, f) && filtros.every((g) => g(f)))
      if (orden) { const { col, asc } = orden; r.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1) * (asc ? 1 : -1)) }
      return r
    }
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filtros.push((f) => f[c] === v); return q },
      gt: (c: string, v: number) => { filtros.push((f) => Number(f[c]) > v); return q },
      order: (col: string, o?: { ascending?: boolean }) => { orden = { col, asc: o?.ascending !== false }; return q },
      update: (d: Fila) => { cambios = d; return q },
      maybeSingle: () => Promise.resolve({ data: filas()[0] ?? null, error: null }),
      then: (ok: (r: unknown) => unknown) => {
        if (cambios) { const afectadas = filas(); afectadas.forEach((f) => Object.assign(f, cambios)); escrituras.push({ tabla, cambios: cambios! }); return Promise.resolve({ data: afectadas, error: null }).then(ok) }
        return Promise.resolve({ data: filas(), error: null }).then(ok)
      },
    }
    return q
  }
  return { from, auth: { getUser: async () => ({ data: { user: { id: usuario } }, error: null }) } } as unknown as SupabaseClient
}

// Registro de archivos (service role) falso: solo lectura + URL firmada.
const registro: Fila[] = [
  { id: W1, docente_id: A, bucket: 'documentos-generados-ia', ruta: `${A}/1-PLANEACION.docx`, nombre: 'PLANEACION_DIDACTICA.docx', estado: 'activo' },
  { id: P1, docente_id: A, bucket: 'documentos-generados-ia', ruta: `${A}/1-PLANEACION.pdf`, nombre: 'PLANEACION_DIDACTICA.pdf', estado: 'activo' },
  { id: W3, docente_id: A, bucket: 'documentos-generados-ia', ruta: `${A}/3-PLANEACION.docx`, nombre: 'PLANEACION_V1.docx', estado: 'fallido' },
]
let firmas = 0
configurarClienteRegistroArchivos({
  from: () => {
    const filtros: [string, unknown][] = []
    const q = {
      select: () => q,
      eq: (c: string, v: unknown) => { filtros.push([c, v]); return q },
      maybeSingle: () => Promise.resolve({ data: registro.find((f) => filtros.every(([c, v]) => f[c] === v)) ?? null, error: null }),
    }
    return q
  },
  storage: { from: () => ({ createSignedUrl: async (ruta: string) => { firmas++; return { data: { signedUrl: `https://firmada.local/${ruta}` }, error: null } } }) },
} as never)

const TEXTO_V1 = '📋 PLANEACIÓN DIDÁCTICA\nProyecto: Las Leyendas de Nuestra Comunidad\nSesión 1: Lectura de leyendas locales y conversación sobre su origen.'
const TEXTO_V2 = '📋 PLANEACIÓN DIDÁCTICA\nProyecto: Las Leyendas de Nuestra Comunidad (ajustada)\nSesión 1: Entrevista a personas mayores de la comunidad.'
function datos(): Record<string, Fila[]> {
  return {
    planeaciones: [
      { id: 'pl-leyendas-1', docente_id: A, grupo_id: GA, nombre: 'Las Leyendas de Nuestra Comunidad', fecha_inicio: '2026-11-23', fecha_fin: '2026-12-04', estado: 'publicada', version: 2 },
      { id: 'pl-leyendas-2', docente_id: A, grupo_id: GA, nombre: 'Las Leyendas de Nuestra Comunidad', fecha_inicio: '2026-11-24', fecha_fin: '2026-12-07', estado: 'publicada', version: 1 },
      { id: 'pl-cuentos', docente_id: A, grupo_id: GA, nombre: '¡A contar historias! Elaboración de cuentos propios', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-30', estado: 'publicada', version: 1 },
      { id: 'pl-antigua', docente_id: A, grupo_id: GA, nombre: 'Fracciones en la vida diaria', fecha_inicio: '2026-10-05', fecha_fin: '2026-10-16', estado: 'publicada', version: 1, creado_en: '2026-10-01T15:00:00' },
      { id: 'pl-borrador', docente_id: A, grupo_id: GA, nombre: 'Fracciones a medias', fecha_inicio: '2026-10-05', fecha_fin: '2026-10-16', estado: 'borrador', version: 0 },
      { id: 'pl-otro-grupo', docente_id: A, grupo_id: GA2, nombre: 'Fracciones del otro grupo', fecha_inicio: '2026-10-05', fecha_fin: '2026-10-16', estado: 'publicada', version: 1 },
      { id: 'pl-otro-docente', docente_id: B, grupo_id: GB, nombre: '¡A contar historias! Elaboración de cuentos propios', fecha_inicio: '2026-11-24', fecha_fin: '2026-11-30', estado: 'publicada', version: 1 },
    ],
    planeacion_versiones: [
      { id: 'v-l1-1', planeacion_id: 'pl-leyendas-1', docente_id: A, numero: 1, origen: 'derivada', contenido: TEXTO_V1, documento_word_archivo_id: W1, documento_pdf_archivo_id: P1, creada_en: '2026-11-24T06:40:00Z' },
      { id: 'v-l1-2', planeacion_id: 'pl-leyendas-1', docente_id: A, numero: 2, origen: 'modificacion', contenido: TEXTO_V2, documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-25T10:00:00Z' },
      { id: 'v-l2-1', planeacion_id: 'pl-leyendas-2', docente_id: A, numero: 1, origen: 'derivada', contenido: 'otro texto de leyendas, bastante largo para la prueba de contenido', documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-25T00:25:00Z' },
      { id: 'v-c-1', planeacion_id: 'pl-cuentos', docente_id: A, numero: 1, origen: 'aprobacion', contenido: '📋 PLANEACIÓN DIDÁCTICA\nProyecto: ¡A contar historias!\nSesión 1: Escuchar cuentos y reconocer su estructura.', documento_word_archivo_id: W3, documento_pdf_archivo_id: null, creada_en: '2026-11-25T04:38:08Z' },
      { id: 'v-a-1', planeacion_id: 'pl-antigua', docente_id: A, numero: 1, origen: 'derivada', contenido: null, documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-24T00:00:00Z' },
      { id: 'v-od-1', planeacion_id: 'pl-otro-docente', docente_id: B, numero: 1, origen: 'aprobacion', contenido: 'TEXTO DE OTRO DOCENTE', documento_word_archivo_id: null, documento_pdf_archivo_id: null, creada_en: '2026-11-25T00:00:00Z' },
    ],
    conversaciones_chat: [{ id: CONV, docente_id: A, planeacion_activa: null }],
  }
}
const sesion = (grupo = GA) => ({ docente_id: A, grupo_activo_id: grupo, ciclo_escolar_id: null, fecha_actual: '2026-11-25' }) as unknown as SesionContexto
const HOY = '2026-11-25'

async function consultar(tablas: Record<string, Fila[]>, mensaje: string, opciones: { usuario?: string; grupo?: string; canal?: 'voice' | 'text' } = {}) {
  const escrituras: { tabla: string; cambios: Fila }[] = []
  const sb = crearCliente(opciones.usuario ?? A, tablas, escrituras)
  const c = detectarConsultaPlaneacion(mensaje, HOY)
  if (!c) return { texto: null as string | null, escrituras, consulta: c }
  const texto = await ejecutarHerramientaDeModulo(clasificacionConsultaPlaneacion(c), { sb, sesion: opciones.grupo ? sesion(opciones.grupo) : sesion(), userId: opciones.usuario ?? A, zonaHoraria: 'America/Hermosillo', canal: opciones.canal ?? 'text', conversacionId: CONV })
  return { texto, escrituras, consulta: c }
}
const referencia = (t: Record<string, Fila[]>) => t.conversaciones_chat[0].planeacion_activa as { planeacionId: string | null; numero: number | null; opciones: string[] } | null
const tarjetas = (texto: string | null) => [...(texto ?? '').matchAll(/\[\[DOCUMENTO_ARCHIVO:([^\]]+)\]\]/g)].map((m) => JSON.parse(Buffer.from(m[1], 'base64').toString('utf-8')))

async function main() {
  // 1. Detección determinista: consulta sí; generar, modificar o aprobar no.
  const t = (m: string) => detectarConsultaPlaneacion(m, HOY)
  verificar(t('Muéstrame la planeación de las leyendas')?.tipo === 'por_nombre' && (t('Muéstrame la planeación de las leyendas') as { nombre: string }).nombre === 'las leyendas', '1a. "Muéstrame la planeación de las leyendas" → consulta por nombre')
  verificar(t('¿Qué planeaciones hice en noviembre?')?.tipo === 'por_fechas' && t('mis planeaciones')?.tipo === 'listado' && t('Quiero ver mis planeaciones')?.tipo === 'listado', '1b. Listado y periodo ("¿Qué planeaciones hice en noviembre?", "mis planeaciones")')
  verificar(['Elabora una planeación de las leyendas', 'Hazme una planeación sobre fracciones', 'Genera otra planeación de leyendas', 'Crea una planeación nueva'].every((m) => t(m) === null), '1c. Generar una planeación nunca es consulta')
  verificar(['Cambia la planeación de las leyendas', 'Modifica la sesión 2 de la planeación', 'Ajusta la planeación de cuentos', 'Agrega una sesión a la planeación'].every((m) => t(m) === null), '1d. Modificar una planeación nunca es consulta')
  verificar(['Apruébala', 'Guarda la planeación'].every((m) => t(m) === null) && t('Hola, ¿cómo estás?') === null && t('¿Qué es una planeación didáctica?') === null, '1e. Aprobar, conversación o preguntas generales no se interceptan')
  verificar((t('Muéstrame la versión anterior de la planeación de cuentos') as { version: unknown } | null)?.version === 'anterior' && (t('Ábreme la versión 1 de la planeación de las leyendas') as { version: unknown; nombre: string } | null)?.version === 1
    && (t('Ábreme la versión 1 de la planeación de las leyendas') as { nombre: string }).nombre === 'las leyendas', '1f. Versión explícita con nombre (anterior, número), sin contaminar el nombre')
  verificar(t('muéstrame la versión anterior')?.tipo === 'version' && t('la 2')?.tipo === 'seleccion' && seleccionEnTexto('la segunda') === 2 && seleccionEnTexto('Opción 3') === 3 && seleccionEnTexto('la última') === -1 && seleccionEnTexto('la segunda sesión') === null,
    '1g. Seguimientos: "la versión anterior", "la 2", "la segunda", "opción 3", "la última" (no "la segunda sesión")')
  verificar(t('Muéstrame la planeación') === null, '1h. Sin nombre ni periodo no se adivina: decide el orquestador de siempre')
  verificar(['Quiero ver una planeación de fracciones', 'Muéstrame un ejemplo de planeación', '¿Qué planeaciones me recomiendas para diciembre?'].every((m) => t(m) === null), '1i. "Una planeación de…", ejemplos o recomendaciones no son consultas de planeaciones guardadas')

  // 2. Periodos de fechas (deterministas)
  const r1 = rangoDeFechasEnTexto('en noviembre', HOY), r2 = rangoDeFechasEnTexto('esta semana', HOY), r3 = rangoDeFechasEnTexto('del 3 al 14 de noviembre', HOY), r4 = rangoDeFechasEnTexto('del 28 de octubre al 5 de noviembre', HOY)
  verificar(r1?.desde === '2026-11-01' && r1?.hasta === '2026-11-30' && r2?.desde === '2026-11-23' && r2?.hasta === '2026-11-29' && r3?.desde === '2026-11-03' && r3?.hasta === '2026-11-14' && r4?.desde === '2026-10-28' && r4?.hasta === '2026-11-05',
    '2a. Mes, semana y rangos "del 3 al 14 de noviembre" / "del 28 de octubre al 5 de noviembre"')
  verificar(rangoDeFechasEnTexto('en diciembre', HOY)?.desde === '2025-12-01', '2b. Un mes posterior al actual se entiende del año anterior (ya trabajado)')
  const frase = (t: string) => `Trabajaste 4 planeaciones ${rangoDeFechasEnTexto(t, HOY)?.etiqueta}`
  verificar(frase('en noviembre') === 'Trabajaste 4 planeaciones en noviembre' && frase('noviembre') === 'Trabajaste 4 planeaciones en noviembre' && frase('en noviembre de 2025') === 'Trabajaste 4 planeaciones en noviembre de 2025'
    && frase('esta semana') === 'Trabajaste 4 planeaciones esta semana' && frase('el mes pasado') === 'Trabajaste 4 planeaciones el mes pasado' && frase('del 3 al 14 de noviembre') === 'Trabajaste 4 planeaciones del 3 al 14 de noviembre',
    '2c. El periodo se expresa como complemento correcto de la frase ("en noviembre", "esta semana", "del 3 al 14 de noviembre")')

  // 3. Búsqueda por nombre y versión
  const lista = datos().planeaciones as { nombre: string }[]
  verificar(coincidenciasPorNombre(lista, 'las leyendas').length === 2 && coincidenciasPorNombre(lista, 'cuentos propios').length === 2 && coincidenciasPorNombre(lista, 'fracciones vida').length === 1 && coincidenciasPorNombre(lista, 'astronomía').length === 0,
    '3a. Coincidencia por palabras significativas; nunca se elige una entre varias')
  const vs = (datos().planeacion_versiones as unknown as VersionPlaneacion[]).filter((v) => v.planeacion_id === 'pl-leyendas-1')
  verificar(elegirVersion(vs, 2, null, null)?.numero === 2 && elegirVersion(vs, 2, 'anterior', null)?.numero === 1 && elegirVersion(vs, 2, 'original', null)?.numero === 1 && elegirVersion(vs, 2, 1, null)?.numero === 1 && elegirVersion(vs, 2, 5, null) === null && elegirVersion(vs, 2, 'anterior', 1) === null,
    '3b. Vigente por omisión; anterior/original/N solo si se piden; inexistente → ninguna')

  // 4. Consulta de una planeación: texto canónico de la versión + archivos originales + referencia
  {
    const tablas = datos()
    const r = await consultar(tablas, 'Muéstrame la planeación de cuentos propios')
    const ts = tarjetas(r.texto)
    verificar(!!r.texto?.startsWith('📋 PLANEACIÓN DIDÁCTICA\nProyecto: ¡A contar historias!') && r.texto.includes('Versión 1'), '4a. Muestra el texto canónico de la versión vigente, tal cual, con una línea discreta de versión')
    verificar(ts.length === 0 && !r.texto?.includes('TEXTO DE OTRO DOCENTE'), '4b. Archivo "fallido" no se entrega; nunca aparece la planeación homónima de otro docente')
    const ref = referencia(tablas)
    verificar(ref?.planeacionId === 'pl-cuentos' && ref.numero === 1 && ref.opciones.length === 0 && r.escrituras.every((e) => e.tabla === 'conversaciones_chat'),
      '4c. La conversación guarda solo la referencia (planeación + versión), sin contenido; única escritura')
  }
  {
    const tablas = datos()
    tablas.planeaciones = tablas.planeaciones.filter((p) => p.id !== 'pl-leyendas-2')
    const antes = firmas
    const r = await consultar(tablas, 'Ábreme la versión 1 de la planeación de las leyendas')
    const ts = tarjetas(r.texto)
    verificar(!!r.texto?.startsWith(TEXTO_V1) && r.texto.includes('Versión 1 de 2') && !r.texto.includes('(vigente)'), '4d. Versión anterior pedida explícitamente: su propio texto, marcada como no vigente')
    verificar(ts.length === 2 && ts[0].tipo === 'word' && ts[0].archivoId === W1 && ts[1].tipo === 'pdf' && ts[1].archivoId === P1 && !!ts[1].urlVer && ts.every((x) => x.tipoDocumento === 'planeacion') && firmas - antes === 4,
      '4e. Tarjetas con los archivos ORIGINALES de esa versión (Word y PDF), firmados, sin regenerar')
    const vigente = await consultar(tablas, 'Muéstrame la planeación de las leyendas')
    verificar(!!vigente.texto?.startsWith(TEXTO_V2) && vigente.texto.includes('(vigente)') && tarjetas(vigente.texto).length === 0 && vigente.texto.includes('versión anterior'),
      '4f. Por omisión, la vigente (v2, sin archivos aún: no se toman los de la v1)')
    const anterior = await consultar(tablas, 'muéstrame la versión anterior')
    verificar(!!anterior.texto?.startsWith(TEXTO_V1) && referencia(tablas)?.numero === 1, '4g. "La versión anterior" sobre la planeación en contexto')
    const otra = await consultar(tablas, 'muéstrame la versión anterior')
    verificar(!!otra.texto?.includes('no encontré una versión anterior') && referencia(tablas)?.numero === 1, '4h. Sin versión anterior a la v1: lo dice y no cambia la referencia')
  }

  // 5. Ambigüedad: pregunta breve numerada; "la 2" elige
  {
    const tablas = datos()
    const r = await consultar(tablas, 'Muéstrame la planeación de las leyendas')
    verificar(!!r.texto?.includes('Encontré 2 planeaciones') && r.texto.includes('**1** · Las Leyendas de Nuestra Comunidad · 24 nov – 7 dic 2026') && r.texto.includes('**2** · Las Leyendas de Nuestra Comunidad · 23 nov – 4 dic 2026') && !r.texto.includes('creada el') && ultimaRespuestaEsPregunta([{ role: 'assistant', content: r.texto }]),
      '5a. Dos homónimas: número visible (no lista de Markdown) y fechas para distinguirlas, sin elegir ninguna')
    verificar(JSON.stringify(referencia(tablas)?.opciones) === JSON.stringify(['pl-leyendas-2', 'pl-leyendas-1']), '5b. Las opciones quedan en la referencia, en el mismo orden mostrado')
    const sel = await consultar(tablas, 'la 2')
    verificar(!!sel.texto?.startsWith(TEXTO_V2) && referencia(tablas)?.planeacionId === 'pl-leyendas-1' && referencia(tablas)?.opciones.length === 0, '5c. "la 2" muestra la segunda opción y limpia las opciones')
    const fuera = await consultar(tablas, 'la 7')
    verificar(fuera.texto === '¿De qué planeación? Dime su nombre o el periodo en que la trabajaste.', '5d. Un número sin lista pendiente no adivina')
  }

  // 6. Periodo, listado, histórica sin texto, aislamiento
  {
    const tablas = datos()
    const nov = await consultar(tablas, '¿Qué planeaciones trabajé en noviembre?')
    verificar(!!nov.texto?.includes('Trabajaste 3 planeaciones en noviembre') && !nov.texto.includes('Fracciones'), '6a. Planeaciones trabajadas en un periodo (traslape de fechas), solo confirmadas del grupo')
    const todas = await consultar(tablas, 'mis planeaciones')
    verificar(!!todas.texto?.includes('Tienes 4 planeaciones') && !todas.texto.includes('a medias') && !todas.texto.includes('otro grupo') && !todas.texto.includes('OTRO DOCENTE'), '6b. Listado: sin borradores sin confirmar, ni otro grupo, ni otro docente')
    const antigua = await consultar(tablas, 'Muéstrame la planeación de fracciones')
    verificar(antigua.texto === '«Fracciones en la vida diaria» (5 oct – 16 oct 2026) es una planeación anterior y no tengo su texto completo guardado.', '6c. Histórica sin texto recuperable: lo dice, sin inventar contenido ni archivos')
    const otroGrupo = await consultar(datos(), 'Muéstrame la planeación de fracciones del otro grupo', { grupo: GA })
    verificar(otroGrupo.texto === 'No encontré planeaciones que coincidan con esa búsqueda.', '6d. Una planeación de otro grupo del mismo docente no aparece con el grupo activo')
    const deB = await consultar(datos(), 'Muéstrame la planeación de cuentos propios', { usuario: B, grupo: GB })
    verificar(!!deB.texto?.startsWith('TEXTO DE OTRO DOCENTE'), '6e. Cada docente ve solo las suyas (RLS)')
    const voz = await consultar(datos(), 'Muéstrame la planeación de cuentos propios', { canal: 'voice' })
    verificar(!!voz.texto?.startsWith('Aquí está «¡A contar historias! Elaboración de cuentos propios»'), '6f. Voz: una frase breve antes del texto')
  }

  // 7. Planeación consultada como documento activo: no se modifica; su Word es el original
  {
    const tablas = datos()
    tablas.planeaciones = tablas.planeaciones.filter((p) => p.id !== 'pl-leyendas-2')
    const sb = crearCliente(A, tablas, [])
    await consultar(tablas, 'Ábreme la versión 1 de la planeación de las leyendas')
    const v = await versionConsultada(sb, CONV)
    verificar(v?.numero === 1 && contieneContenidoConsultado(`${TEXTO_V1}\n\nVersión 1 de 2\nINSTRUCCIÓN DEL MAESTRO: cambia la sesión 1`, v) && !contieneContenidoConsultado('Otro documento cualquiera', v), '7a. Reconoce el texto consultado dentro de la edición del documento activo')
    verificar(pideModificar('Cámbiale la sesión 2') && pideModificar('agrega una actividad') && !pideModificar('dámela en Word') && !pideModificar('¿cuántas sesiones tiene?'), '7b. Distingue modificar de pedir formato o preguntar')
    const word = await respuestaArchivoOriginal(v!, 'word', async () => ({ nombre: 'PLANEACION_DIDACTICA.docx', url: 'https://x', urlVer: 'https://y' }))
    const sinPdf = await respuestaArchivoOriginal({ ...v!, documento_pdf_archivo_id: null }, 'pdf', async () => null)
    verificar(tarjetas(word)[0]?.archivoId === W1 && sinPdf === 'Esta versión de la planeación no tiene su PDF original guardado.', '7c. "Dame el Word" entrega el original de esa versión; sin original, lo dice (nunca regenera)')
  }

  // 8. Ruta del Chat (estático)
  {
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const iDetecta = ruta.indexOf('detectarConsultaPlaneacion(textoConsulta')
    const iClasifica = ruta.indexOf('await clasificarNivel0(mensaje, sesion')
    verificar(iDetecta > 0 && iDetecta < iClasifica && /consultaPlaneacion\s*\?\s*clasificacionConsultaPlaneacion\(consultaPlaneacion\)\s*:\s*await clasificarNivel0/.test(ruta),
      '8a. La consulta inequívoca se resuelve antes del clasificador (sin llamada de IA)')
    verificar(/ultimaRespuestaEsPregunta\(historialMensajes\)/.test(ruta) && /referencia\?\.opciones\.length/.test(ruta), '8b. "la 2" solo tras la pregunta de elegir y con opciones guardadas')
    const iGuard = ruta.indexOf('MENSAJE_MODIFICAR_NO_DISPONIBLE)')
    const iConversion = ruta.indexOf('if (supabaseUser && userId && tipoHerramientaSolicitado && !esEdicionDocumento) {')
    verificar(iGuard > 0 && iGuard < iConversion && /respuestaArchivoOriginal\(consultada, formatoOriginal, firmarOriginalPropio/.test(ruta), '8c. Modificar o convertir la planeación consultada se resuelve antes de editar o regenerar')
    const herramienta = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'herramientasModulo.ts'), 'utf-8')
    verificar(/versionesDePlaneacion\(ctx\.sb, p\.id\)/.test(herramienta) && !/planeacion_proyectos/.test(herramienta) && !/obtenerPlaneacionPorId/.test(herramienta), '8d. La consulta lee planeacion_versiones, nunca la proyección')
  }

  // 9. Modificar una planeación GUARDADA sin documento activo en el cliente (regresión)
  {
    const modificar = async (tablas: Record<string, Fila[]>, historial: { role: string; content: string }[], mensaje: string, usuario = A, grupo = GA) =>
      resolverModificacionGuardada({ sb: crearCliente(usuario, tablas, []), grupoId: grupo, conversacionId: CONV, historial, mensaje })
    const NO_DISPONIBLE = (nombre: string) => `Todavía no puedo modificar «${nombre}» desde el Chat. Puedo mostrártela o darte sus archivos originales.`
    const CUENTOS = '¡A contar historias! Elaboración de cuentos propios'

    // Tras consultar (el historial trae el texto mostrado), sin documento activo.
    const tablas = datos()
    const consulta = await consultar(tablas, 'Muéstrame la planeación de cuentos propios')
    const historial = [{ role: 'user', content: 'Muéstrame la planeación de cuentos propios' }, { role: 'assistant', content: extraerMarcadorRecuperado(consulta.texto ?? '').texto }]
    verificar(await modificar(tablas, historial, 'Cámbiale la sesión 2') === NO_DISPONIBLE(CUENTOS) && await modificar(tablas, historial, 'ajústala') === NO_DISPONIBLE(CUENTOS),
      '9a. "Cámbiale la sesión 2" / "ajústala" tras consultar: referente = planeación mostrada (contexto persistido) → bloqueo, nunca creación')
    verificar(await modificar(tablas, historial, 'Cambia mi grupo a cuarto') === null && await modificar(tablas, [...historial, { role: 'user', content: 'gracias' }, { role: 'assistant', content: '¡De nada!' }], 'Cámbiala') === null,
      '9b. Un cambio ajeno ("cambia mi grupo a cuarto") o un pronombre lejos de la planeación no se bloquean')
    verificar(await modificar(datos(), [], 'Modifica la planeación de cuentos propios: agrega una sesión de lectura') === NO_DISPONIBLE(CUENTOS) && referencia(tablas)?.planeacionId === 'pl-cuentos',
      '9c. Nombre citado sin conversación previa: se resuelve contra las planeaciones guardadas del docente y grupo → bloqueo')
    {
      const t2 = datos()
      const r = await modificar(t2, [], 'Cambia la planeación de las leyendas')
      verificar(!!r?.includes('Encontré 2 planeaciones guardadas con ese nombre.') && r.includes('¿Cuál quieres modificar?') && referencia(t2)?.opciones.length === 2 && (t2.conversaciones_chat[0].planeacion_activa as { intencion?: string }).intencion === 'modificar',
        '9d. Referente ambiguo: pregunta breve numerada, sin elegir')
      const sb = crearCliente(A, t2, [])
      const eleccion = await ejecutarHerramientaDeModulo(clasificacionConsultaPlaneacion({ tipo: 'seleccion', indice: 1 }), { sb, sesion: sesion(), userId: A, zonaHoraria: null, canal: 'text', conversacionId: CONV })
      verificar(eleccion === NO_DISPONIBLE('Las Leyendas de Nuestra Comunidad') && ultimaRespuestaEsPregunta([{ role: 'assistant', content: r ?? '' }]) && referencia(t2)?.planeacionId === 'pl-leyendas-2',
        '9e. "la 1" tras la pregunta de modificar: identifica la planeación y responde que aún no se puede (no la modifica ni la muestra)')
    }
    const BORRADOR = '📋 PLANEACIÓN DIDÁCTICA\nLas Leyendas de Nuestra Comunidad\n\n📎 RESUMEN PARA GUARDAR\nNombre: Las Leyendas de Nuestra Comunidad\nFecha de inicio: 2026-12-01\nFecha de fin: 2026-12-12'
    const conBorrador = [...historial, { role: 'user', content: 'Ahora una nueva de leyendas' }, { role: 'assistant', content: BORRADOR }]
    verificar(await modificar(datos(), conBorrador, 'Cámbiale la sesión 2') === null && await modificar(datos(), conBorrador, 'Cambia la planeación de las leyendas: agrega una salida') === null,
      '9f. Con un borrador en curso, la edición normal sigue intacta (aunque exista una guardada homónima)')
    verificar(await modificar(datos(), [], 'Elabora una planeación de las leyendas y agrega una evaluación') === null && await modificar(datos(), [], '¿Qué día es hoy?') === null,
      '9g. Crear una planeación (aunque diga "agrega") o conversar no es modificar')
    verificar(await modificar(datos(), [], 'Cambia la planeación') === '¿Qué planeación guardada quieres modificar? Dime su nombre.', '9h. "Cambia la planeación" sin documento ni contexto: pide su nombre (nunca crea)')
    verificar(await modificar(datos(), [], 'Modifica la planeación de fracciones del otro grupo') === null && await modificar(datos(), [], 'Modifica la planeación de cuentos propios', B, GB) === NO_DISPONIBLE(CUENTOS)
      && referencia(datos())?.planeacionId !== 'pl-otro-docente', '9i. Solo planeaciones del docente y grupo activo (server-side)')
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(ruta.indexOf('resolverModificacionGuardada({') > 0 && ruta.indexOf('resolverModificacionGuardada({') < ruta.indexOf('await clasificarNivel0(mensaje, sesion'), '9j. Se resuelve antes del clasificador: sin IA y sin llegar al flujo de creación')
  }

  // 10. Una consulta nunca crea registros en Historial (regresión)
  {
    const tablas = datos()
    tablas.planeaciones = tablas.planeaciones.filter((p) => p.id !== 'pl-leyendas-2')
    const conArchivos = await consultar(tablas, 'Ábreme la versión 1 de la planeación de las leyendas')
    const sinArchivos = await consultar(tablas, 'Muéstrame la planeación de cuentos propios')
    const servidor = (t: string | null) => `${t}
${MARCADOR_DOCUMENTO_RECUPERADO}` // lo que añade la ruta a toda consulta
    const procesar = (t: string) => {
      const { texto, recuperado } = extraerMarcadorRecuperado(t)
      const archivos = tarjetas(texto)
      return documentoParaHistorial(texto.replace(/\[\[DOCUMENTO_ARCHIVO:[^\]]+\]\]/g, '').trim(), { archivos, recuperado })
    }
    verificar(procesar(servidor(sinArchivos.texto)) === null && procesar(servidor(conArchivos.texto)) === null, '10a. Consulta sin archivos y con Word/PDF: ninguna se guarda en Historial')
    verificar(documentoParaHistorial(TEXTO_V1) !== null && documentoParaHistorial(TEXTO_V1, { contenidoOriginal: TEXTO_V1, archivos: [{ tipo: 'word', archivoId: W1 }], recuperado: true }) === null,
      '10b. La decisión es semántica (recuperado), no por archivos: un documento generado sí se guarda; uno recuperado nunca')
    verificar(extraerMarcadorRecuperado(servidor('hola')).texto === 'hola' && !extraerMarcadorRecuperado(servidor(sinArchivos.texto)).texto.includes('[['.concat('DOCUMENTO_RECUPERADO')), '10c. El marcador nunca se muestra')
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    const motor = readFileSync(join(__dirname, '..', 'lib', 'asistente', 'motores', 'motorTextoClaude.ts'), 'utf-8')
    verificar(ruta.includes("intencion_principal === 'planeacion_consultar' ? `${respuestaDeModulo}\\n${MARCADOR_DOCUMENTO_RECUPERADO}`") && ruta.includes('firmarOriginalPropio(userId))}\\n${MARCADOR_DOCUMENTO_RECUPERADO}`')
      && motor.includes('documentoParaHistorial(respuestaLimpia, { contenidoOriginal, archivos, recuperado })') && motor.indexOf('extraerMarcadorRecuperado(respuesta)') < motor.indexOf('extraerTextoFinal(respuestaSinRecuperado)'),
      '10d. La ruta marca toda consulta y entrega de originales; el cliente lo respeta antes de decidir el Historial')
  }

  // 11. Regresión (Preview 34bb723): secuencia real cuentos → leyendas → "la 2" → "¿Qué planeaciones trabajé en noviembre?"
  {
    const tablas = datos()
    // Cuarta planeación de noviembre: mismo nombre y periodo que otra (solo las distingue su creación).
    tablas.planeaciones.push({ id: 'pl-leyendas-3', docente_id: A, grupo_id: GA, nombre: 'Las Leyendas de Nuestra Comunidad', fecha_inicio: '2026-11-24', fecha_fin: '2026-12-07', estado: 'publicada', version: 1, creado_en: '2026-11-25T00:25:36.1' })
    tablas.planeaciones.find((p) => p.id === 'pl-leyendas-2')!.creado_en = '2026-11-24T18:10:00'
    Object.assign(tablas.planeacion_versiones.find((v) => v.id === 'v-l2-1')!, { documento_word_archivo_id: W1, documento_pdf_archivo_id: P1 })
    tablas.planeacion_versiones.push({ id: 'v-l3-1', planeacion_id: 'pl-leyendas-3', docente_id: A, numero: 1, origen: 'aprobacion', contenido: '📋 PLANEACIÓN DIDÁCTICA\nLas Leyendas (tercera)\nSesión 1: relatos orales de la comunidad.', documento_word_archivo_id: W1, documento_pdf_archivo_id: P1, creada_en: '2026-11-25T00:25:40+00:00' })
    await consultar(tablas, 'Muéstrame la planeación de cuentos propios')
    const leyendas = await consultar(tablas, 'Muéstrame la planeación de las leyendas')
    verificar(!!leyendas.texto?.includes('Encontré 3 planeaciones') && /\*\*1\*\* · Las Leyendas de Nuestra Comunidad · 24 nov – 7 dic 2026 · creada el 24 nov 2026, 17:25/.test(leyendas.texto) && /\*\*2\*\* · Las Leyendas de Nuestra Comunidad · 24 nov – 7 dic 2026 · creada el 24 nov 2026, 11:10/.test(leyendas.texto)
      && /\*\*3\*\* · Las Leyendas de Nuestra Comunidad · 23 nov – 4 dic 2026\n/.test(leyendas.texto),
      '11a. Homónimas en nombre y periodo: orden estable y distinguidas por su fecha y hora real de creación (hora local del docente); la de otro periodo no lo necesita')
    const segunda = await consultar(tablas, 'la 2')
    verificar(!!segunda.texto?.startsWith('otro texto de leyendas') && referencia(tablas)?.planeacionId === 'pl-leyendas-2' && tarjetas(segunda.texto).length === 2 && segunda.texto.includes('_Versión 1 · guardada el 24 nov 2026, 17:25 · 24 nov – 7 dic 2026_'),
      '11b. "La 2" muestra esa planeación con su Word y PDF y, discreta, su versión y fecha en que se guardó')
    const noviembre = await consultar(tablas, '¿Qué planeaciones trabajé en noviembre?')
    verificar(!!noviembre.texto?.includes('Trabajaste 4 planeaciones en noviembre') && ['pl-leyendas-1', 'pl-leyendas-2', 'pl-leyendas-3', 'pl-cuentos'].every((id) => referencia(tablas)?.opciones.includes(id)) && !noviembre.texto.includes('Fracciones'),
      '11c. "¿Qué planeaciones trabajé en noviembre?" tras ver una planeación: las 4 cuyo intervalo coincide total o parcialmente con noviembre (incluye la que termina en diciembre)')
    // Por el orquestador (clasificador) el periodo llega como "noviembre", sin preposición.
    const sb = crearCliente(A, tablas, [])
    const porClasificador = await ejecutarHerramientaDeModulo({ ...clasificacionConsultaPlaneacion({ tipo: 'listado' }), tipo_consulta_planeacion: 'por_periodo', periodo_planeacion_consulta: 'noviembre' }, { sb, sesion: sesion(), userId: A, zonaHoraria: 'America/Hermosillo', canal: 'text', conversacionId: CONV })
    verificar(!!porClasificador?.includes('Trabajaste 4 planeaciones en noviembre') && rangoDeFechasEnTexto('noviembre de 2026', HOY)?.desde === '2026-11-01' && rangoDeFechasEnTexto('noviembre 2025', HOY)?.desde === '2025-11-01',
      '11d. El periodo dicho sin preposición ("noviembre", como lo entrega el clasificador) y con año explícito se interpreta igual')
    const ruta = readFileSync(join(__dirname, '..', 'app', 'api', 'chat', 'route.ts'), 'utf-8')
    verificar(/if \(esEdicionDocumento && !formatoOriginal && detectarConsultaPlaneacion\(instruccion/.test(ruta) && /const textoConsulta = consultaDesdeEdicion \?\?/.test(ruta),
      '11e. Servidor: una consulta enviada como edición de la planeación consultada (cliente anterior) se atiende como consulta, sin IA')
  }

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main()
