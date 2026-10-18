// scripts/verificar-logs-sin-datos-personales.ts
//
// Privacidad de logs — Etapas A y B. Sin red ni llamadas facturables, con
// datos 100% ficticios. Comprueba que los logs del servidor no registran
// nombres de alumnos, correos del docente ni respuestas completas de RPC,
// conservando indicadores técnicos útiles:
// 1. Escaneo estático de todos los console.* de app/api/** y lib/**
//    (módulos de servidor) contra interpolaciones de datos personales.
// 2. Las plantillas REALES de los logs corregidos, evaluadas con datos
//    ficticios: solo indicadores (presente/ausente, candidatos=N, id).
// 3. aplicarCorreccionAlumno REAL ante una respuesta inesperada de la RPC
//    con valores ficticios: el log no contiene ningún valor.
//
// Ejecutar: npx tsx --tsconfig ./tsconfig.json scripts/verificar-logs-sin-datos-personales.ts
// Opcional: VERIFICAR_RAIZ (raíz alternativa a verificar, p. ej. un índice exportado).

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

let fallos = 0
function verificar(condicion: boolean, mensaje: string) {
  if (condicion) {
    console.log(`✓ ${mensaje}`)
  } else {
    fallos++
    console.error(`✗ ${mensaje}`)
  }
}

const RAIZ = process.env.VERIFICAR_RAIZ || join(__dirname, '..')

// Módulos que se ejecutan en el NAVEGADOR (sus console.* no llegan a los
// logs del servidor) — fuera del alcance de esta etapa.
const SOLO_CLIENTE = [/^lib\/asistente\/AsistenteService\.ts$/, /^lib\/asistente\/motores\//, /^lib\/asistente\/persistencia\.ts$/]

function archivos(dir: string): string[] {
  const salida: string[] = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) salida.push(...archivos(p))
    else if (/\.(ts|tsx)$/.test(n)) salida.push(p)
  }
  return salida
}

// Llamadas console.* completas (con sus argumentos), respetando paréntesis anidados.
function llamadasConsole(fuente: string): { linea: number; texto: string }[] {
  const res: { linea: number; texto: string }[] = []
  const re = /console\.(log|error|warn|info)\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(fuente))) {
    let d = 0, k = m.index + m[0].length - 1
    for (; k < fuente.length; k++) {
      if (fuente[k] === '(') d++
      else if (fuente[k] === ')') { d--; if (d === 0) break }
    }
    res.push({ linea: fuente.slice(0, m.index).split('\n').length, texto: fuente.slice(m.index, k + 1) })
  }
  return res
}

// Interpolaciones/argumentos prohibidos en un log de servidor.
const PROHIBIDOS: [RegExp, string][] = [
  [/alumno_nombre_detectado(?!\s*\?\s*'presente')/, 'nombre detectado de un alumno'],
  [/opciones_alumno_ambiguo(?!\.length)/, 'nombres de candidatos de una ambigüedad'],
  [/\bnombre_completo\b/, 'nombre completo de un alumno'],
  [/\bnombreReal\b/, 'nombre real de un alumno'],
  [/\.email\b/, 'correo'],
  [/\$\{[^}]*\bcurp\b[^}]*\}/i, 'CURP'],
  [/\$\{[^}]*fecha_nacimiento[^}]*\}/, 'fecha de nacimiento'],
  [/\$\{[^}]*\b(valorAnterior|valorNuevo|valorActual|valor_anterior|valor_nuevo|valor_alumno_propuesto|valorProporcionado)\b[^}]*\}/, 'valor de un dato personal'],
  // Etapa B — nombres de archivo solo a través de archivoSeguro()/formatoArchivoSeguro().
  [/\$\{(?![^}]*(archivoSeguro|formatoArchivoSeguro)\()[^}]*(\bnombre\b|\.nombre\b|\bnombreArchivo\b)[^}]*\}/, 'nombre de archivo'],
  // Etapa B — texto libre de una incidencia/ilustración: solo presencia o longitud.
  [/\$\{\s*descripcion\s*\}|descripcion\.slice\(/, 'descripción en texto libre'],
  // (resultado.error crudo se comprueba POR FLUJO en FLUJOS_ETAPA_B — una
  // prohibición global marcaría sitios fuera del alcance auditado, p. ej.
  // actualizar_perfil_docente, que queda para la revisión de la Etapa C.)
  // Etapa B — nunca message/details/hint de un error en el texto del log.
  [/\$\{[^}]*\b(e|err|error)\.(message|details|hint)\b[^}]*\}/, 'mensaje o detalle crudo de un error'],
]

// Etapa B — en estos flujos (importación, corrección, registro escolar,
// almacenamiento de documentos) ningún objeto de error se pasa crudo a la
// consola: solo errorSeguro(), que deja tipo, código/categoría y status.
const FLUJOS_ETAPA_B: [string, RegExp | null][] = [
  ['app/api/alumnos/aplicar-correccion/route.ts', null],
  ['app/api/importar-alumnos/route.ts', null],
  ['app/api/importar-alumnos/comparar/route.ts', null],
  ['lib/documentGen/herramientas.ts', null],
  ['lib/motorContexto.ts', /\[(CORRECCION_ALUMNO|REGISTRO_ESCOLAR)\]/],
  ['lib/asistente/herramientasModulo.ts', /(consultar|corregir)_dato_alumno|consultar_incidencias_alumno/],
  ['app/api/chat/route.ts', /\[REGISTRO_ESCOLAR\] error ejecutando|marcar_asistencia_individual|registrar_incidencia/],
  ['app/api/upload-documento/route.ts', null],
  ['app/api/asistencia-guardar/route.ts', null],
  ['lib/emparejarAlumno.ts', null],
  ['app/api/generar-ficha-descriptiva/route.ts', null],
]

async function main() {
  // ===== 1. Escaneo estático =====
  console.log('\n— 1. Escaneo estático de logs del servidor —')
  const lista = [...archivos(join(RAIZ, 'app/api')), ...archivos(join(RAIZ, 'lib'))]
    .map((p) => ({ p, rel: relative(RAIZ, p) }))
    .filter(({ rel }) => !SOLO_CLIENTE.some((re) => re.test(rel)))
  let totalLlamadas = 0
  const hallazgos: string[] = []
  for (const { p, rel } of lista) {
    const fuente = readFileSync(p, 'utf8')
    for (const { linea, texto } of llamadasConsole(fuente)) {
      totalLlamadas++
      for (const [re, motivo] of PROHIBIDOS) if (re.test(texto)) hallazgos.push(`${rel}:${linea} (${motivo})`)
    }
  }
  verificar(totalLlamadas > 100 && hallazgos.length === 0, `ningún log de servidor interpola nombres, correos, CURP, fechas de nacimiento ni valores personales (${totalLlamadas} llamadas en ${lista.length} archivos)${hallazgos.length ? ' → ' + hallazgos.join('; ') : ''}`)

  const motor = readFileSync(join(RAIZ, 'lib/motorContexto.ts'), 'utf8')
  const fnCorreccion = motor.slice(motor.indexOf('export async function aplicarCorreccionAlumno('), motor.indexOf('\n}\n', motor.indexOf('export async function aplicarCorreccionAlumno(')))
  const logsCorreccion = llamadasConsole(fnCorreccion).map((l) => l.texto)
  verificar(logsCorreccion.length >= 2 && logsCorreccion.every((t) => !/,\s*(data|respuesta)\s*\)$/.test(t)), 'aplicarCorreccionAlumno nunca vuelca el objeto de respuesta de la RPC (data/respuesta)')

  for (const [rel, filtro] of FLUJOS_ETAPA_B) {
    const llamadas = llamadasConsole(readFileSync(join(RAIZ, rel), 'utf8')).filter((l) => !filtro || filtro.test(l.texto))
    const crudas = llamadas.filter((l) => /,\s*(e|err|error|resultado\.error)\s*\)$/.test(l.texto) || /^console\.\w+\(\s*(e|err|error)\s*\)$/.test(l.texto) || /\.(message|details|hint)\b/.test(l.texto))
    verificar(llamadas.length > 0 && crudas.length === 0, `${rel}: ${llamadas.length} log(s) del flujo sin objetos de error crudos ni message/details/hint${crudas.length ? ' → líneas ' + crudas.map((c) => c.linea).join(',') : ''}`)
  }

  // ===== 2. Plantillas reales evaluadas con datos ficticios =====
  console.log('\n— 2. Plantillas reales de los logs corregidos —')
  const chat = readFileSync(join(RAIZ, 'app/api/chat/route.ts'), 'utf8')
  const plantilla = (fuente: string, marca: string): string => {
    const i = fuente.indexOf(marca)
    const ini = fuente.lastIndexOf('`', i)
    let k = ini + 1, d = 0
    for (; k < fuente.length; k++) {
      const ch = fuente[k]
      if (ch === '\\') { k++; continue }
      if (d === 0 && ch === '`') break
      if (ch === '$' && fuente[k + 1] === '{') { d++; k++; continue }
      if (d > 0 && ch === '{') d++
      else if (d > 0 && ch === '}') d--
    }
    return fuente.slice(ini, k + 1)
  }
  const NOMBRE = 'Alumna Ficticia de Prueba'
  const CANDIDATOS = ['Candidato Ficticio Uno', 'Candidato Ficticio Dos']
  const ent = (nombre: string | null, opciones: string[] = []) => ({ alumno_id: nombre ? '00000000-0000-4000-8000-0000000000aa' : null, alumno_nombre_detectado: nombre, alumno_ambiguo: opciones.length > 0, opciones_alumno_ambiguo: opciones })
  const tplNivel0 = plantilla(chat, '[NIVEL0] intencion=')
  const evalNivel0 = (e: ReturnType<typeof ent>) => new Function('clasificacion', 'sesion', `return ${tplNivel0}`)({ intencion_principal: 'ficha_descriptiva', nivel_ejecucion: 4, entidades_resueltas: e, datos_faltantes: [], accion_planeacion_generar: null }, { ciclo_escolar_id: 'ciclo-ficticio' }) as string
  const conNombre = evalNivel0(ent(NOMBRE)), sinNombre = evalNivel0(ent(null))
  verificar(!conNombre.includes(NOMBRE) && /alumno_detectado=presente /.test(conNombre) && /alumno_detectado=ausente /.test(sinNombre), '[NIVEL0]: alumno_detectado=presente|ausente, nunca el nombre')
  verificar(/alumno_id=00000000-0000-4000-8000-0000000000aa/.test(conNombre) && /intencion=ficha_descriptiva nivel=4/.test(conNombre) && /datos_faltantes=\[\]/.test(conNombre), '[NIVEL0]: se conserva el diagnóstico técnico (intención, nivel, alumno_id, datos faltantes)')
  const tplAmbiguo = plantilla(chat, ' — alumno ambiguo: ')
  const ambiguo = new Function('clasificacion', `return ${tplAmbiguo}`)({ intencion_principal: 'consultar_dato_alumno', entidades_resueltas: ent(null, CANDIDATOS) }) as string
  verificar(CANDIDATOS.every((c) => !ambiguo.includes(c)) && /alumno ambiguo: candidatos=2$/.test(ambiguo), 'ambigüedad: solo el número de candidatos, nunca sus nombres')
  const rt = readFileSync(join(RAIZ, 'app/api/realtime-token/route.ts'), 'utf8')
  const tplVoz = plantilla(rt, '[VOZ][token-endpoint] sesión válida')
  const voz = new Function('user', 'MODELO_REALTIME', 'voz', 'VOZ_DEFECTO', 'instrucciones', `return ${tplVoz}`)({ id: '00000000-0000-4000-8000-0000000000dd', email: 'docente.ficticio@prueba.local' }, 'modelo', 'voz', 'voz', 'x') as string
  verificar(!voz.includes('docente.ficticio@prueba.local') && !voz.includes('@') && /usuario=00000000-0000-4000-8000-0000000000dd/.test(voz), 'token de voz: identificador técnico del usuario, nunca su correo')

  // ===== 3. aplicarCorreccionAlumno REAL ante una respuesta inesperada =====
  console.log('\n— 3. Respuesta inesperada de la RPC de corrección —')
  const CURP_ANT = 'XEXX010101MNEXXXA8', CURP_NUEVA = 'XAXX020202HNEXXXB5'
  let respuestaRpc: unknown = null
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/rest/v1/rpc/confirmar_correccion_alumno')) return new Response(JSON.stringify(respuestaRpc), { status: 200, headers: { 'content-type': 'application/json' } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const { createClient } = await import('@supabase/supabase-js')
  const sb = createClient('http://supabase.prueba.local', 'anon-prueba')
  const motorMod = await import(join(RAIZ, 'lib/motorContexto.ts'))
  const propuesta = { v: 1, propuestaId: '00000000-0000-4000-8000-0000000000p1'.replace('p', 'a'), docenteId: '00000000-0000-4000-8000-0000000000d1', conversacionId: '00000000-0000-4000-8000-0000000000c1', alumnoId: '00000000-0000-4000-8000-0000000000a1', alumnoNombre: NOMBRE, campo: 'curp', valorAnterior: CURP_ANT, valorNuevo: CURP_NUEVA, generadoEn: new Date().toISOString() }
  const capturar = async (resp: unknown) => {
    respuestaRpc = resp
    const errores: string[] = []
    const original = console.error
    console.error = (...a: unknown[]) => { errores.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
    let r: { exito: boolean } | null = null
    try { r = await motorMod.aplicarCorreccionAlumno(sb, propuesta, 'texto') } finally { console.error = original }
    return { r, log: errores.join('\n') }
  }
  const casos: [string, unknown, string][] = [
    ['propuesta_id distinta', { resultado: 'actualizado', propuesta_id: 'otra', valor_anterior: CURP_ANT, valor_nuevo: CURP_NUEVA }, 'resultado=actualizado propuesta_coincide=false'],
    ['resultado desconocido', { resultado: 'raro', valor: CURP_ANT, nombre: NOMBRE }, 'resultado=desconocido propuesta_coincide=false'],
    ['respuesta nula', null, 'resultado=ausente propuesta_coincide=false'],
  ]
  for (const [n, resp, esperado] of casos) {
    const { r, log } = await capturar(resp)
    verificar(r?.exito === false && !log.includes(CURP_ANT) && !log.includes(CURP_NUEVA) && !log.includes(NOMBRE) && log.includes(esperado), `${n}: el log solo trae «${esperado}» (sin CURP ni nombre) y el resultado sigue siendo fallo`)
  }
  const ok = await capturar({ resultado: 'actualizado', propuesta_id: propuesta.propuestaId, valor_anterior: CURP_ANT, valor_nuevo: CURP_NUEVA })
  verificar(ok.r?.exito === true && ok.log === '', 'respuesta válida: mismo resultado de siempre y ningún log de error')

  // ===== 4. Etapa B: helpers de log seguro con datos ficticios =====
  console.log('\n— 4. archivoSeguro / errorSeguro —')
  const seg = await import(join(RAIZ, 'lib/logSeguro.ts'))
  const ARCHIVO = 'FICHA_DESCRIPTIVA_Alumna_Ficticia_de_Prueba.docx'
  verificar(seg.archivoSeguro(ARCHIVO, 12345) === 'formato=docx bytes=12345' && seg.archivoSeguro('Citatorio Alumno Ficticio.PDF') === 'formato=pdf' && seg.archivoSeguro('Alumna.raro', -1) === 'formato=otro' && seg.archivoSeguro(undefined) === 'formato=desconocido',
    'archivoSeguro: solo formato (lista cerrada) y bytes válidos; nunca el nombre del archivo')
  const pg23505 = { code: '23505', message: 'duplicate key value violates unique constraint "alumnos_nombre_docente_id_key"', details: `Key (nombre, docente_id)=(${NOMBRE}, 00000000-0000-4000-8000-0000000000d1) already exists.`, hint: `Revisa ${NOMBRE}` }
  const r23505 = seg.errorSeguro(pg23505)
  verificar(r23505 === 'tipo=objeto codigo=23505 categoria=violacion_unicidad' && !r23505.includes(NOMBRE) && !/Key \(|duplicate|alumnos_nombre/.test(r23505), 'PostgreSQL 23505 con details/hint ficticios → solo código y categoría (sin nombre, details, hint ni restricción)')
  const casosError: [string, unknown, string][] = [
    ['código desconocido', { code: 'XX999', message: `fallo con ${CURP_ANT}` }, 'tipo=objeto codigo=otro'],
    ['error de Storage', { name: 'StorageApiError', statusCode: '400', message: `The resource ${ARCHIVO} already exists` }, 'tipo=StorageApiError status=400'],
    ['error del SDK de IA', Object.assign(new Error(`prompt con ${NOMBRE}`), { name: 'BadRequestError', status: 400 }), 'tipo=BadRequestError status=400'],
    ['Error genérico', new Error(`no se encontró ${NOMBRE} ${CURP_ANT}`), 'tipo=Error'],
    ['clase desconocida', Object.assign(new Error('x'), { name: `Clase${NOMBRE}` }), 'tipo=Error'],
    ['cadena', `error con ${CURP_ANT}`, 'tipo=string'],
    ['nulo', null, 'tipo=nulo'],
    ['código PostgREST', { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: NOMBRE }, 'tipo=objeto codigo=PGRST116 categoria=sin_filas'],
  ]
  for (const [n, e, esperado] of casosError) {
    const r = seg.errorSeguro(e)
    verificar(r === esperado && !r.includes(NOMBRE) && !r.includes(CURP_ANT) && !r.includes(ARCHIVO), `errorSeguro (${n}) → «${esperado}»`)
  }
  verificar(seg.errorSeguro({ message: 'STALE_CURRENT_VALUE' }, ['STALE_CURRENT_VALUE']) === 'tipo=objeto codigo_sistema=STALE_CURRENT_VALUE' && seg.errorSeguro({ message: NOMBRE }, ['STALE_CURRENT_VALUE']) === 'tipo=objeto', 'solo los códigos de sistema de una lista cerrada explícita pueden registrarse tal cual')

  // ===== 5. Flujo real: error 23505 de la RPC de corrección =====
  console.log('\n— 5. Error 23505 de la RPC en aplicarCorreccionAlumno —')
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/rest/v1/rpc/confirmar_correccion_alumno')) return new Response(JSON.stringify(pg23505), { status: 409, headers: { 'content-type': 'application/json' } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const errores: string[] = []
  const original = console.error
  console.error = (...a: unknown[]) => { errores.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  let r409: { exito: boolean; definitivo?: boolean } | null = null
  try { r409 = await motorMod.aplicarCorreccionAlumno(sb, propuesta, 'texto') } finally { console.error = original }
  const log409 = errores.join('\n')
  verificar(r409?.exito === false && /codigo=23505 categoria=violacion_unicidad/.test(log409) && !log409.includes(NOMBRE) && !/Key \(|duplicate key/.test(log409), 'RPC con 23505 y details ficticios → el log trae código y categoría, nunca el nombre ni el detalle; el resultado sigue siendo fallo')

  // ===== 6. Etapa B ampliada: incidencias, escrituras, PostgreSQL, SyntaxError, hostiles =====
  console.log('\n— 6. Incidencias, escrituras y errores con datos ficticios —')
  const DESCRIPCION = `${NOMBRE} golpeó a un compañero ficticio durante el recreo`
  const tplInc = plantilla(chat, 'registrar_incidencia sin alumno_id')
  const inc = (d: string | null) => new Function('alumnoId', 'descripcion', 'grupoId', `return ${tplInc}`)(null, d, 'g') as string
  verificar(!inc(DESCRIPCION).includes(DESCRIPCION) && !inc(DESCRIPCION).includes(NOMBRE) && /descripcion_presente=true /.test(inc(DESCRIPCION)) && /descripcion_presente=false /.test(inc(null)), 'incidencia sin datos completos: descripcion_presente=true|false, nunca el texto')
  for (const marca of ['marcar_asistencia_individual — Supabase rechazó la escritura', 'registrar_incidencia — Supabase rechazó la escritura']) {
    const tpl = plantilla(chat, marca)
    const linea = (err: unknown) => new Function('alumnoId', 'resultado', `return ${tpl}`)('00000000-0000-4000-8000-0000000000aa', { exito: false, error: err }) as string
    verificar(!linea(`Failing row contains (${NOMBRE}, ${DESCRIPCION})`).includes(NOMBRE) && /error=presente$/.test(linea('x')) && /error=ausente$/.test(linea(undefined)), `${marca.split(' — ')[0]}: la cadena de error devuelta nunca se registra (error=presente|ausente)`)
  }
  for (const marca of ['marcar_asistencia_individual — excepción escribiendo', 'registrar_incidencia — excepción escribiendo']) {
    const tpl = plantilla(chat, marca)
    const linea = new Function('alumnoId', 'errorSeguro', 'e', `return ${tpl}`)('a1', seg.errorSeguro, { code: '23514', details: `Failing row contains (${NOMBRE}, ${DESCRIPCION})` }) as string
    verificar(/codigo=23514 categoria=violacion_check$/.test(linea) && !linea.includes(NOMBRE), `${marca.split(' — ')[0]}: excepción → código y categoría, sin la fila`)
  }
  const pgCasos: [string, Record<string, unknown>, string][] = [
    ['23514 check', { code: '23514', message: 'new row for relation "incidencias" violates check constraint "incidencias_tipo_check"', details: `Failing row contains (1, ${NOMBRE}, otro, ${DESCRIPCION}).` }, 'tipo=objeto codigo=23514 categoria=violacion_check'],
    ['23502 not null', { code: '23502', message: 'null value in column "descripcion" violates not-null constraint', details: `Failing row contains (2, ${NOMBRE}, conducta, null).` }, 'tipo=objeto codigo=23502 categoria=valor_nulo'],
    ['23505 unique', { code: '23505', message: 'duplicate key', details: `Key (nombre, docente)=(${NOMBRE}, d1) already exists.` }, 'tipo=objeto codigo=23505 categoria=violacion_unicidad'],
  ]
  for (const [n, e, esperado] of pgCasos) {
    const r = seg.errorSeguro(e)
    verificar(r === esperado && !r.includes(NOMBRE) && !r.includes('Failing row'), `PostgreSQL ${n} con fila ficticia → «${esperado}»`)
  }
  let errSintaxis: unknown = null
  try { JSON.parse(`${NOMBRE} mostró avances en lectura`) } catch (e) { errSintaxis = e }
  const rSintaxis = seg.errorSeguro(errSintaxis)
  verificar(String((errSintaxis as Error).message).includes(NOMBRE.slice(0, 5)) && rSintaxis === 'tipo=SyntaxError' && !rSintaxis.includes(NOMBRE.slice(0, 5)), 'SyntaxError de JSON.parse con fragmento personal → solo tipo=SyntaxError (el fragmento existía en message)')
  const revocable = Proxy.revocable({}, {}); revocable.revoke()
  const hostiles: unknown[] = [Object.defineProperty({}, 'code', { get() { throw new Error('boom') } }), Object.defineProperty({}, 'name', { get() { throw new Error('boom') } }), revocable.proxy, Object.create(null), { code: 23505 }, Symbol('x'), BigInt(10)]
  let sinExcepcion = true
  const salidas = hostiles.map((h) => { try { return seg.errorSeguro(h) } catch { sinExcepcion = false; return 'LANZÓ' } })
  const salidasArchivo = [revocable.proxy, Object.defineProperty({}, 'length', { get() { throw new Error('boom') } }), Symbol('x')].map((h) => { try { return seg.archivoSeguro(h, h) } catch { sinExcepcion = false; return 'LANZÓ' } })
  verificar(sinExcepcion && salidas[0] === 'tipo=no_inspeccionable' && salidas[1] === 'tipo=no_inspeccionable' && salidas[2] === 'tipo=no_inspeccionable' && salidas[4] === 'tipo=objeto codigo=otro' && salidasArchivo.every((x) => /^formato=(desconocido|no_inspeccionable)$/.test(x)), `getters hostiles, Proxy revocado y entradas inesperadas → nunca lanza, indicador constante (${salidas.join(' | ')})`)
  verificar(seg.errorSeguro({}) === 'tipo=objeto' && seg.errorSeguro(new (class ErrorPropio extends Error {})('x')) === 'tipo=Error', 'errores desconocidos → tipo genérico controlado')
  const herr = readFileSync(join(RAIZ, 'lib/documentGen/herramientas.ts'), 'utf8')
  const tplIlus = plantilla(herr, '[PIPELINE IMAGEN-DOC:generacion] Falló generando la ilustración')
  const ilus = new Function('orden', 'descripcion', 'errorSeguro', 'err', `return ${tplIlus}`)(2, `Retrato de ${NOMBRE} leyendo`, seg.errorSeguro, new Error(`fallo con ${NOMBRE}`)) as string
  verificar(!ilus.includes(NOMBRE) && /longitud_descripcion=\d+\): tipo=Error$/.test(ilus), 'ilustración fallida: solo la longitud de la descripción y el tipo de error')

  // ===== 7. Flujo real: generar-ficha-descriptiva con salida no-JSON del modelo =====
  console.log('\n— 7. /api/generar-ficha-descriptiva ante salida no-JSON —')
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.prueba.local'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-prueba'
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba'
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const json = (c: unknown, status = 200) => new Response(JSON.stringify(c), { status, headers: { 'content-type': 'application/json' } })
    if (url.includes('/rest/v1/rpc/contexto_alumno')) return json({ datos_personales: { nombre: NOMBRE } })
    if (url.startsWith('https://api.anthropic.com/')) return json({ id: 'msg', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: `${NOMBRE} mostró avances notables en lectura.` }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
    throw new Error('RED BLOQUEADA EN LA PRUEBA: ' + url)
  }) as typeof fetch
  const rutaFicha = await import(join(RAIZ, 'app/api/generar-ficha-descriptiva/route.ts'))
  const capt: string[] = []
  const orig = console.error
  console.error = (...a: unknown[]) => { capt.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) }
  let resFicha: Response | null = null
  try { resFicha = await rutaFicha.POST({ json: async () => ({ alumno_id: 'a1', ciclo_escolar_id: 'c1', access_token: 't' }) } as never) } finally { console.error = orig }
  const cuerpoFicha = resFicha ? await resFicha.json() : null
  verificar(resFicha?.status === 500 && cuerpoFicha?.error === 'La IA no devolvió un formato válido. Intenta de nuevo.', 'respuesta HTTP y mensaje al docente sin cambios (500, mismo texto)')
  verificar(capt.join('\n') === 'Error en generar-ficha-descriptiva: tipo=SyntaxError' && !capt.join('').includes(NOMBRE.slice(0, 5)), 'el log del error de formato no contiene ningún fragmento de la ficha generada')

  console.log(fallos === 0 ? '\nTodas las pruebas pasaron.' : `\n${fallos} prueba(s) fallaron.`)
  process.exit(fallos === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('ERROR DEL VERIFICADOR:', e)
  process.exit(1)
})
